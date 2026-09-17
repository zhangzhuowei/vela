import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_PROBE_PROMPT,
  IMAGE_PROBE_SIZE,
  buildImageUrl,
  detectImage,
  requestImageBytes,
} from '../utils/image-generate'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const model = {
  baseUrl: 'https://api.example.com/v1',
  modelName: 'gemini-3.1-flash-image',
  apiKey: 'sk-test',
  protocol: 'openai' as const,
}

const geminiModel = {
  baseUrl: 'https://sub2.222uc.xyz/antigravity',
  modelName: 'gemini-3.1-flash-image',
  apiKey: 'sk-test',
  protocol: 'gemini' as const,
}

describe('buildImageUrl', () => {
  it('appends /v1/images/generations when the base has no version suffix', () => {
    expect(buildImageUrl('https://api.example.com')).toBe(
      'https://api.example.com/v1/images/generations',
    )
  })

  it('keeps an existing /vN suffix and only appends /images/generations', () => {
    expect(buildImageUrl('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1/images/generations',
    )
    expect(buildImageUrl('https://api.example.com/api/paas/v4')).toBe(
      'https://api.example.com/api/paas/v4/images/generations',
    )
  })
})

describe('detectImage', () => {
  it('recognizes png / jpeg / webp / gif magic bytes', () => {
    expect(detectImage(PNG_1X1)).toEqual({ ext: 'png', mime: 'image/png' })
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff]))).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    expect(detectImage(Buffer.from('RIFF....WEBP', 'ascii'))).toEqual({ ext: 'webp', mime: 'image/webp' })
    expect(detectImage(Buffer.from('GIF89a', 'ascii'))).toEqual({ ext: 'gif', mime: 'image/gif' })
    expect(detectImage(Buffer.from([0x00, 0x01]))).toEqual({ ext: 'png', mime: 'image/png' })
  })
})

describe('requestImageBytes', () => {
  it('rejects incomplete config and empty prompt without calling fetch', async () => {
    const fetchImpl = vi.fn()
    const missing = await requestImageBytes(
      { baseUrl: '', modelName: 'x', apiKey: 'k', protocol: 'openai' },
      { prompt: 'hi', fetchImpl },
    )
    expect(missing).toEqual({ ok: false, error: '文生图模型配置不完整' })

    const empty = await requestImageBytes(model, { prompt: '  ', fetchImpl })
    expect(empty).toEqual({ ok: false, error: '提示词为空' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns image bytes from b64_json and does not require a project path', async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString('base64') }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )

    const result = await requestImageBytes(model, {
      prompt: IMAGE_PROBE_PROMPT,
      size: IMAGE_PROBE_SIZE,
      fetchImpl: fetchImpl as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.equals(PNG_1X1)).toBe(true)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/images/generations')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'gemini-3.1-flash-image',
      prompt: IMAGE_PROBE_PROMPT,
      image_size: IMAGE_PROBE_SIZE,
      n: 1,
      batch_size: 1,
    })
  })

  it('downloads bytes when the API returns a url', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ images: [{ url: 'https://cdn.example.com/a.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(PNG_1X1, { status: 200 })
    })

    const result = await requestImageBytes(model, { prompt: 'red square', fetchImpl: fetchImpl as typeof fetch })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.equals(PNG_1X1)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('surfaces HTTP and empty-payload failures', async () => {
    const httpFail = vi.fn(async () =>
      new Response('upstream down', { status: 502 }),
    )
    const http = await requestImageBytes(model, { prompt: 'x', fetchImpl: httpFail as typeof fetch })
    expect(http.ok).toBe(false)
    if (!http.ok) expect(http.error).toMatch(/文生图接口失败 \(502\).*upstream down/)

    const empty = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    )
    const missing = await requestImageBytes(model, { prompt: 'x', fetchImpl: empty as typeof fetch })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toMatch(/^接口未返回图片数据/)
  })

  it('uses Gemini generateContent (not OpenAI /images/generations) when protocol is gemini', async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [
                { text: 'ok' },
                { inlineData: { mimeType: 'image/png', data: PNG_1X1.toString('base64') } },
              ],
            },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const result = await requestImageBytes(geminiModel, {
      prompt: IMAGE_PROBE_PROMPT,
      size: '1024x1024',
      fetchImpl: fetchImpl as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.equals(PNG_1X1)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(
      'https://sub2.222uc.xyz/antigravity/v1beta/models/gemini-3.1-flash-image:generateContent',
    )
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('sk-test')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(String(init?.body)) as {
      contents: unknown
      generationConfig: { responseModalities: string[]; imageConfig?: { aspectRatio: string; imageSize?: string } }
    }
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: IMAGE_PROBE_PROMPT }] }])
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE'])
    expect(body.generationConfig.imageConfig?.aspectRatio).toBe('1:1')
    expect(body.generationConfig.imageConfig?.imageSize).toBe('1K')
  })

  it('reads Gemini snake_case inline_data parts', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG_1X1.toString('base64') } }] },
        }],
      }), { status: 200 }),
    )
    const result = await requestImageBytes(geminiModel, {
      prompt: 'x',
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.equals(PNG_1X1)).toBe(true)
  })

  it('unwraps nested response.candidates and later candidates', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        response: {
          candidates: [
            { content: { parts: [{ thought: true, text: 'thinking' }] }, finishReason: 'STOP' },
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1.toString('base64') } }] } },
          ],
        },
      }), { status: 200 }),
    )
    const result = await requestImageBytes(geminiModel, {
      prompt: 'x',
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.equals(PNG_1X1)).toBe(true)
  })

  it('surfaces text-only Gemini replies instead of a bare missing-image message', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '我可以帮你画一只猫，但这里只返回了文字。' }] },
        }],
      }), { status: 200 }),
    )
    const result = await requestImageBytes(geminiModel, {
      prompt: 'x',
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/接口未返回图片数据/)
      expect(result.error).toMatch(/STOP/)
      expect(result.error).toMatch(/只返回了文字/)
    }
  })
})
