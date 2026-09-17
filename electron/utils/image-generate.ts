import { ModelProfile } from '../../src/shared/ipc-channels'

/** 设置页探活用的短提示词：只验证接口能出图，不追求质量 */
export const IMAGE_PROBE_PROMPT = 'a tiny red square on a white background'
/** 与正式出图默认尺寸一致，避免部分网关因 size 不支持而误报失败 */
export const IMAGE_PROBE_SIZE = '1024x1024'

export type ImageModelRef = Pick<ModelProfile, 'baseUrl' | 'modelName' | 'apiKey' | 'protocol'>

export type ImageBytesResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string }

const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)/

/**
 * 构造 OpenAI 兼容文生图端点：
 *  - .../v1  → .../v1/images/generations
 *  - .../api/paas/v4 → .../v4/images/generations
 *  - 无版本号 → 追加 /v1/images/generations
 */
export function buildImageUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v\d+$/.test(base)) return `${base}/images/generations`
  return `${base}/v1/images/generations`
}

/** 与聊天 GeminiProvider 同一路径：{base}/v1beta/models/{model}:generateContent */
export function buildGeminiImageUrl(baseUrl: string, modelName: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}/v1beta/models/${modelName}:generateContent`
}

/** 把 1024x1024 这类像素尺寸映射成 Gemini imageConfig.aspectRatio */
export function aspectRatioFromSize(size: string): string {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(size.trim())
  if (!m) return '1:1'
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return '1:1'
  const r = w / h
  if (r >= 1.3) return '16:9'
  if (r <= 0.77) return '9:16'
  return '1:1'
}

export function imageSizeLabel(size: string): '512' | '1K' | '2K' | '4K' {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(size.trim())
  const max = m ? Math.max(Number(m[1]), Number(m[2])) : 1024
  if (max >= 3000) return '4K'
  if (max >= 1800) return '2K'
  if (max >= 700) return '1K'
  return '512'
}

/** 通过魔数识别图片类型，决定扩展名与 MIME */
export function detectImage(buf: Buffer): { ext: string; mime: string } {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' }
  }
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { ext: 'gif', mime: 'image/gif' }
  }
  return { ext: 'png', mime: 'image/png' }
}

function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  if (buf[0] === 0xff && buf[1] === 0xd8) return true
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true
  if (buf.toString('ascii', 0, 3) === 'GIF') return true
  return false
}

function decodeImageData(raw: string, requireMagic: boolean): Buffer | null {
  const uri = DATA_URI_RE.exec(raw)
  const b64 = (uri ? uri[1] : raw).replace(/\s+/g, '')
  if (b64.length < 32) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 16) return null
    if (looksLikeImage(buf)) return buf
    if (!requireMagic && b64.length > 200) return buf
  } catch { /* ignore */ }
  return null
}

/** 从任意 JSON 信封里抠出第一张图（inlineData / b64_json / data URI / 嵌套 response） */
export function extractImageBytesFromPayload(data: unknown): Buffer | null {
  return walkForImage(data, 0, false)
}

function walkForImage(node: unknown, depth: number, knownField: boolean): Buffer | null {
  if (depth > 10 || node == null) return null
  if (typeof node === 'string') {
    if (knownField) return decodeImageData(node, false)
    const uri = DATA_URI_RE.exec(node)
    return uri ? decodeImageData(uri[0], true) : null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForImage(item, depth + 1, knownField)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null

  const obj = node as Record<string, unknown>
  if (typeof obj.b64_json === 'string') {
    const found = decodeImageData(obj.b64_json, false)
    if (found) return found
  }
  const inline = obj.inlineData ?? obj.inline_data
  if (inline) {
    const found = walkForImage(inline, depth + 1, true)
    if (found) return found
  }
  if (typeof obj.data === 'string' && (knownField || obj.mimeType || obj.mime_type)) {
    const found = decodeImageData(obj.data, false)
    if (found) return found
  }

  for (const [key, value] of Object.entries(obj)) {
    const childKnown = key === 'inlineData' || key === 'inline_data' || key === 'b64_json'
    const found = walkForImage(value, depth + 1, childKnown || knownField)
    if (found) return found
  }
  return null
}

function collectCandidates(obj: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(obj.candidates)) return obj.candidates as Array<Record<string, unknown>>
  const nested = obj.response
  if (nested && typeof nested === 'object') {
    const inner = nested as Record<string, unknown>
    if (Array.isArray(inner.candidates)) return inner.candidates as Array<Record<string, unknown>>
  }
  const data = obj.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const inner = data as Record<string, unknown>
    if (Array.isArray(inner.candidates)) return inner.candidates as Array<Record<string, unknown>>
  }
  return []
}

export function formatMissingImageError(data: unknown): string {
  if (!data || typeof data !== 'object') return `接口未返回图片数据（type=${typeof data}）`
  const obj = data as Record<string, unknown>
  const keys = Object.keys(obj).slice(0, 10).join(',') || '-'
  const candidates = collectCandidates(obj)
  const finish = candidates
    .map((c) => c.finishReason ?? c.finish_reason)
    .filter(Boolean)
    .join('|') || '-'
  const feedback = obj.promptFeedback ?? obj.prompt_feedback
  const block = feedback && typeof feedback === 'object'
    ? (feedback as Record<string, unknown>).blockReason ?? (feedback as Record<string, unknown>).block_reason
    : undefined
  const partKinds: string[] = []
  const texts: string[] = []
  for (const candidate of candidates) {
    const content = candidate.content
    const parts = content && typeof content === 'object'
      ? (content as Record<string, unknown>).parts
      : undefined
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      partKinds.push(Object.keys(rec).join('+') || '-')
      if (typeof rec.text === 'string' && rec.text.trim()) {
        texts.push(rec.text.trim().replace(/\s+/g, ' ').slice(0, 80))
      }
    }
  }
  const text = texts.join(' ').slice(0, 160) || '-'
  const parts = partKinds.slice(0, 8).join('/') || '-'
  return `接口未返回图片数据（keys=${keys}; finish=${finish}; block=${block ?? '-'}; parts=${parts}; text=${text}）`
}

function collectRemoteImageUrls(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || node == null) return out
  if (Array.isArray(node)) {
    for (const item of node) collectRemoteImageUrls(item, depth + 1, out)
    return out
  }
  if (typeof node !== 'object') return out
  const obj = node as Record<string, unknown>
  const mime = String(obj.mimeType ?? obj.mime_type ?? '')
  const uri = obj.fileUri ?? obj.file_uri ?? (mime.startsWith('image/') ? obj.url : undefined)
  if (typeof uri === 'string' && /^https?:\/\//i.test(uri)) out.push(uri)
  for (const value of Object.values(obj)) collectRemoteImageUrls(value, depth + 1, out)
  return out
}

async function requestOpenAiImageBytes(
  model: ImageModelRef,
  options: {
    prompt: string
    size: string
    negativePrompt?: string
    fetchImpl: typeof fetch
  },
): Promise<ImageBytesResult> {
  const url = buildImageUrl(model.baseUrl)
  const body: Record<string, unknown> = {
    model: model.modelName,
    prompt: options.prompt,
    image_size: options.size,
    batch_size: 1,
    n: 1,
  }
  const negativePrompt = options.negativePrompt?.trim()
  if (negativePrompt) body.negative_prompt = negativePrompt

  const res = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const t = await res.text()
    return { ok: false, error: `文生图接口失败 (${res.status}): ${t.slice(0, 300)}` }
  }

  const data = await res.json() as unknown
  const embedded = extractImageBytesFromPayload(data)
  if (embedded) return { ok: true, bytes: embedded }

  const rec = data && typeof data === 'object' ? data as {
    images?: Array<{ url?: string; b64_json?: string }>
    data?: Array<{ url?: string; b64_json?: string }>
  } : {}
  const item = rec.images?.[0] ?? (Array.isArray(rec.data) ? rec.data[0] : undefined)
  if (item?.url && /^https?:\/\//i.test(item.url)) {
    const imgRes = await options.fetchImpl(item.url)
    if (!imgRes.ok) return { ok: false, error: `下载生成图失败 (${imgRes.status})` }
    return { ok: true, bytes: Buffer.from(await imgRes.arrayBuffer()) }
  }
  return { ok: false, error: formatMissingImageError(data) }
}

async function requestGeminiImageBytes(
  model: ImageModelRef,
  options: {
    prompt: string
    size: string
    negativePrompt?: string
    fetchImpl: typeof fetch
  },
): Promise<ImageBytesResult> {
  const url = buildGeminiImageUrl(model.baseUrl, model.modelName)
  let prompt = options.prompt
  const negativePrompt = options.negativePrompt?.trim()
  if (negativePrompt) prompt = `${prompt}\n\nAvoid: ${negativePrompt}`

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatioFromSize(options.size),
        imageSize: imageSizeLabel(options.size),
      },
    },
  }

  const res = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': model.apiKey,
      'Authorization': `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const t = await res.text()
    return { ok: false, error: `文生图接口失败 (${res.status}): ${t.slice(0, 300)}` }
  }

  const data = await res.json() as unknown
  const embedded = extractImageBytesFromPayload(data)
  if (embedded) return { ok: true, bytes: embedded }

  const remoteUrls = collectRemoteImageUrls(data)
  if (remoteUrls[0]) {
    const imgRes = await options.fetchImpl(remoteUrls[0])
    if (!imgRes.ok) return { ok: false, error: `下载生成图失败 (${imgRes.status})` }
    return { ok: true, bytes: Buffer.from(await imgRes.arrayBuffer()) }
  }
  return { ok: false, error: formatMissingImageError(data) }
}

/**
 * 按模型 protocol 调用对应出图接口，返回原始字节。
 * 不写磁盘，供正式出图与设置页探活共用。
 */
export async function requestImageBytes(
  model: ImageModelRef,
  options: {
    prompt: string
    size?: string
    negativePrompt?: string
    fetchImpl?: typeof fetch
  },
): Promise<ImageBytesResult> {
  const prompt = options.prompt?.trim() ?? ''
  if (!model?.baseUrl || !model?.modelName) {
    return { ok: false, error: '文生图模型配置不完整' }
  }
  if (!prompt) return { ok: false, error: '提示词为空' }

  const fetchImpl = options.fetchImpl ?? fetch
  const size = options.size || IMAGE_PROBE_SIZE
  const args = { prompt, size, negativePrompt: options.negativePrompt, fetchImpl }
  if (model.protocol === 'gemini') return requestGeminiImageBytes(model, args)
  return requestOpenAiImageBytes(model, args)
}
