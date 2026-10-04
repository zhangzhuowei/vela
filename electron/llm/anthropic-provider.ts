/**
 * Anthropic 原生协议（Messages API：POST {baseUrl}/v1/messages）
 *
 * - system 放在请求顶层；相邻的同角色消息合并（Messages API 要求 user / assistant 交替）。
 * - 不发送 temperature / top_p / top_k 与 thinking 字段：Claude Opus 4.7 起的模型对非默认采样参数、
 *   手动思考预算直接返回 400；自适应思考常开的模型会自行思考，较早的模型按默认不思考。
 * - 回复可能以 thinking 块开头：只按类型读取 text 块，流式里只转发 text_delta。
 * - 思考 token 也计入 max_tokens：在调用方要求的输出上限之外额外留出思考余量，避免正文被截断。
 * - 提示缓存：PromptBuilder 用不可见标记圈出 Canon 上下文（src/shared/prompt-cache.ts），这里把它提到 system 开头并打上
 *   cache_control。同一章节的写稿 / 精修 / 审稿 / 修稿共用这段前缀，后续请求按缓存价读取（5 分钟内有请求命中就会续期）。
 */
import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import { ModelProfile } from '../../src/shared/ipc-channels'
import { extractCacheable, stripCacheMarkers } from '../../src/shared/prompt-cache'
import {
  createTimeoutController, withRequestTimeout, timeoutMessage, httpErrorMessage,
  CONNECT_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS,
} from './http'

export const ANTHROPIC_VERSION = '2023-06-01'
/** 当前各款 Claude 都支持的输出上限（Haiku 4.5 为 64K，其余更高）；调用方要求更高时照调用方的 */
const MAX_OUTPUT_TOKENS = 64_000
/** 思考余量：自适应思考的 token 计入 max_tokens */
const THINKING_HEADROOM_TOKENS = 8_000
/** Canon 段短于此长度时不单独提出来（低于模型的最小可缓存长度，提出来也不会生效，徒增提示词结构差异） */
const MIN_CACHEABLE_CHARS = 1_500

type ChatMessage = { role: string; content: string }
type Usage = { promptTokens: number; completionTokens: number; totalTokens: number }

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface TextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicRequest {
  url: string
  headers: Record<string, string>
  body: {
    model: string
    max_tokens: number
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
    system?: TextBlock[]
    stream?: boolean
  }
  /** 是否把 Canon 上下文提到了 system 开头（用于日志） */
  cached: boolean
}

/** 提到 system 后的标题与原位置留下的指引，按提示词语言选用；同一本书各请求语言一致，缓存前缀才能命中 */
const CANON_TEXTS = {
  zh: {
    header: '【Canon 上下文（叙事一致性事实基线）】',
    pointer: '（Canon 上下文已放在系统提示开头，请严格遵循其中的全部事实与约束。）',
  },
  ru: {
    header: '[Контекст канона (базовые факты нарративной согласованности)]',
    pointer: '(Контекст канона приведён в начале системного промпта — строго соблюдайте все факты и ограничения в нём.)',
  },
  en: {
    header: '[Canon Context (narrative consistency baseline)]',
    pointer: '(The Canon Context is provided at the beginning of the system prompt — follow every fact and constraint in it strictly.)',
  },
}

function detectPromptLanguage(text: string): keyof typeof CANON_TEXTS {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  if (/[\u0400-\u04ff]/.test(text)) return 'ru'
  return 'en'
}

/** 规范化接口地址：兼容填到根域名、/v1 或完整 /v1/messages 三种写法 */
export function buildMessagesUrl(baseUrl: string): string {
  const base = (baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
  if (/\/v1\/messages$/.test(base)) return base
  if (/\/v1$/.test(base)) return `${base}/messages`
  return `${base}/v1/messages`
}

/** 组装请求（纯函数，便于测试） */
export function buildAnthropicRequest(
  model: ModelProfile,
  messages: ChatMessage[],
  opts: { maxTokens?: number },
  stream: boolean,
): AnthropicRequest {
  const systemParts: string[] = []
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let canon: { text: string; lang: keyof typeof CANON_TEXTS } | null = null

  for (const message of messages) {
    let content = typeof message.content === 'string' ? message.content : String(message.content ?? '')
    // 第一段标记圈出的 Canon 上下文提到 system 开头缓存；其余标记一律去掉
    if (!canon) {
      const parts = extractCacheable(content)
      if (parts && parts.segment.trim().length >= MIN_CACHEABLE_CHARS) {
        const lang = detectPromptLanguage(`${parts.before}${parts.after}`)
        canon = { text: parts.segment.trim(), lang }
        content = `${parts.before}${CANON_TEXTS[lang].pointer}${parts.after}`
      }
    }
    content = stripCacheMarkers(content)

    if (message.role === 'system') {
      if (content.trim()) systemParts.push(content.trim())
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content += `\n\n${content}`
    else turns.push({ role, content })
  }

  const system: TextBlock[] = []
  if (canon) {
    system.push({ type: 'text', text: `${CANON_TEXTS[canon.lang].header}\n${canon.text}`, cache_control: { type: 'ephemeral' } })
  }
  if (systemParts.length > 0) system.push({ type: 'text', text: systemParts.join('\n\n') })

  const requested = Math.max(1, Math.floor(Number(opts.maxTokens ?? model.maxTokens) || 4096))
  const body: AnthropicRequest['body'] = {
    model: model.modelName,
    max_tokens: Math.max(requested, Math.min(requested + THINKING_HEADROOM_TOKENS, MAX_OUTPUT_TOKENS)),
    messages: turns,
  }
  if (system.length > 0) body.system = system
  if (stream) body.stream = true

  return {
    url: buildMessagesUrl(model.baseUrl),
    headers: {
      'content-type': 'application/json',
      'x-api-key': model.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body,
    cached: !!canon,
  }
}

function toUsage(u: AnthropicUsage | undefined): Usage | undefined {
  if (!u) return undefined
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  const completionTokens = u.output_tokens ?? 0
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

function logCacheUsage(u: AnthropicUsage | undefined): void {
  const written = u?.cache_creation_input_tokens ?? 0
  const read = u?.cache_read_input_tokens ?? 0
  if (written > 0 || read > 0) {
    console.log(`[Vela LLM] Claude 提示缓存：写入 ${written} tokens，命中 ${read} tokens`)
  }
}

/** 模型拒答（stop_reason = refusal）时的错误文案 */
function refusalMessage(details: unknown): string {
  const category = (details as { category?: unknown } | undefined)?.category
  return `Claude 拒绝了本次请求（refusal${typeof category === 'string' && category ? `: ${category}` : ''}）`
}

/** 流式事件里的用量是累计值：各字段取最大值合并 */
function mergeUsage(current: AnthropicUsage, next: AnthropicUsage | undefined): AnthropicUsage {
  if (!next) return current
  const pick = (a?: number, b?: number) => Math.max(a ?? 0, b ?? 0)
  return {
    input_tokens: pick(current.input_tokens, next.input_tokens),
    output_tokens: pick(current.output_tokens, next.output_tokens),
    cache_creation_input_tokens: pick(current.cache_creation_input_tokens, next.cache_creation_input_tokens),
    cache_read_input_tokens: pick(current.cache_read_input_tokens, next.cache_read_input_tokens),
  }
}

export class AnthropicProvider implements ILLMProvider {
  async generate(model: ModelProfile, messages: ChatMessage[], opts: LLMGenerateOptions): Promise<LLMResponse> {
    const request = buildAnthropicRequest(model, messages, opts, false)

    type MessagesResponse = {
      content?: Array<{ type?: string; text?: string }>
      usage?: AnthropicUsage
      stop_reason?: string
      stop_details?: unknown
    }
    let data: MessagesResponse
    try {
      const result = await withRequestTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
        const res = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal,
        })
        if (!res.ok) {
          return { ok: false as const, error: httpErrorMessage('Anthropic API 调用失败', res, await res.text()) }
        }
        return { ok: true as const, data: await res.json() as MessagesResponse }
      })
      if (!result.ok) return { success: false, content: '', error: result.error }
      data = result.data
    } catch (error) {
      return { success: false, content: '', error: error instanceof Error ? error.message : String(error) }
    }

    logCacheUsage(data.usage)
    if (data.stop_reason === 'refusal') {
      return { success: false, content: '', error: refusalMessage(data.stop_details) }
    }
    // 回复可能以 thinking 块开头：只取 text 块
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    return { success: true, content: text, usage: toUsage(data.usage) }
  }

  async generateStream(model: ModelProfile, messages: ChatMessage[], opts: LLMStreamOptions): Promise<void> {
    // 连接阶段用连接超时；收到响应头后切换为流空闲超时，每收到一段数据重新计时
    const tc = createTimeoutController(CONNECT_TIMEOUT_MS, opts.signal)
    let streaming = false
    try {
      const request = buildAnthropicRequest(model, messages, opts, true)
      const res = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: tc.signal,
      })
      if (!res.ok) {
        opts.onError(httpErrorMessage('Anthropic API 调用失败', res, await res.text()))
        return
      }
      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取 Anthropic 响应流')
        return
      }

      streaming = true
      tc.reset(STREAM_IDLE_TIMEOUT_MS)

      const decoder = new TextDecoder()
      let fullText = ''
      let usage: AnthropicUsage = {}
      let stopReason: string | undefined
      let stopDetails: unknown
      let streamError: string | null = null

      const handleData = (json: string) => {
        if (!json) return
        let event: {
          type?: string
          message?: { usage?: AnthropicUsage }
          delta?: { type?: string; text?: string; stop_reason?: string; stop_details?: unknown }
          usage?: AnthropicUsage
          error?: { type?: string; message?: string }
        }
        try {
          event = JSON.parse(json)
        } catch {
          return
        }
        switch (event.type) {
          case 'message_start':
            usage = mergeUsage(usage, event.message?.usage)
            break
          case 'content_block_delta':
            // 只转发正文；thinking_delta / signature_delta 忽略
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              fullText += event.delta.text
              opts.onChunk(event.delta.text)
            }
            break
          case 'message_delta':
            usage = mergeUsage(usage, event.usage)
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
            if (event.delta?.stop_details) stopDetails = event.delta.stop_details
            break
          case 'error':
            // 错误类型原样带上（如 overloaded_error），渲染层据此判断是否可重试
            streamError = `${event.error?.type ?? 'error'}: ${event.error?.message ?? ''}`.trim()
            break
        }
      }

      // SSE 事件可能跨越网络分片边界，跨块保留未完整行
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        tc.reset()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith('data:')) handleData(trimmed.slice(5).trim())
        }
      }
      const tail = buffer.trim()
      if (tail.startsWith('data:')) handleData(tail.slice(5).trim())

      logCacheUsage(usage)
      if (streamError) {
        opts.onError(`Anthropic 流式响应出错（${streamError}）`)
      } else if (stopReason === 'refusal') {
        opts.onError(refusalMessage(stopDetails))
      } else {
        opts.onDone(fullText, toUsage(usage))
      }
    } catch (error) {
      if (tc.timedOut) {
        opts.onError(streaming
          ? timeoutMessage(STREAM_IDLE_TIMEOUT_MS, '流式响应')
          : timeoutMessage(CONNECT_TIMEOUT_MS, '连接'))
      } else if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        const cause = (error as { cause?: { message?: string; code?: string } }).cause
        const causeText = cause && (cause.message || cause.code) ? `（底层原因: ${cause.message || cause.code}）` : ''
        opts.onError(String(error) + causeText)
      }
    } finally {
      tc.dispose()
    }
  }
}
