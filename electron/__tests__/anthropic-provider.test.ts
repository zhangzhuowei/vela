import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ModelProfile } from '../../src/shared/ipc-channels'
import { AnthropicProvider, buildAnthropicRequest, buildMessagesUrl, ANTHROPIC_VERSION } from '../llm/anthropic-provider'
import { markCacheable, stripCacheMarkers, extractCacheable, CACHEABLE_START, CACHEABLE_END } from '../../src/shared/prompt-cache'

const model: ModelProfile = {
  id: 'c1',
  name: 'Claude',
  provider: 'anthropic',
  protocol: 'anthropic',
  modelName: 'claude-sonnet-5-5',
  apiKey: 'sk-ant-test',
  baseUrl: 'https://api.anthropic.com',
  temperature: 0.7,
  maxTokens: 4096,
  purposes: ['generation'],
}

const longCanon = '【正史设定（不可违背）】\n' + '灵气复苏，宗门林立。'.repeat(200)

/** 把 SSE 文本按固定长度切块，模拟事件跨网络分片 */
function sseResponse(events: Array<Record<string, unknown>>, chunkSize = 37): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function runStream(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response))
  return new Promise<{ done?: { text: string; usage?: unknown }; error?: string; chunks: string[] }>((resolve) => {
    const chunks: string[] = []
    void new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写一段' }], {
      temperature: 0.7,
      maxTokens: 1000,
      signal: new AbortController().signal,
      onChunk: (c) => chunks.push(c),
      onDone: (text, usage) => resolve({ done: { text, usage }, chunks }),
      onError: (error) => resolve({ error, chunks }),
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('提示缓存分段标记', () => {
  it('成对标记可取出，其余位置的标记可全部去掉', () => {
    const text = `前言${markCacheable('CANON')}后文`
    expect(extractCacheable(text)).toEqual({ before: '前言', segment: 'CANON', after: '后文' })
    expect(stripCacheMarkers(text)).toBe('前言CANON后文')
    expect(extractCacheable(`只有开头${CACHEABLE_START}没有结尾`)).toBeNull()
    expect(stripCacheMarkers(`a${CACHEABLE_END}b`)).toBe('ab')
    expect(markCacheable('')).toBe('')
  })
})

describe('Anthropic 请求组装', () => {
  it('接口地址兼容根域名、/v1 与完整路径', () => {
    expect(buildMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(buildMessagesUrl('https://api.anthropic.com/')).toBe('https://api.anthropic.com/v1/messages')
    expect(buildMessagesUrl('https://proxy.example/v1')).toBe('https://proxy.example/v1/messages')
    expect(buildMessagesUrl('https://proxy.example/v1/messages')).toBe('https://proxy.example/v1/messages')
    expect(buildMessagesUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  it('system 放顶层、相邻同角色合并；不发送采样参数与 thinking；max_tokens 留出思考余量', () => {
    const req = buildAnthropicRequest(model, [
      { role: 'system', content: '你是一位网文作家。' },
      { role: 'user', content: '第一段' },
      { role: 'user', content: '第二段' },
    ], { maxTokens: 4000 }, true)

    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['x-api-key']).toBe('sk-ant-test')
    expect(req.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(req.body.system).toEqual([{ type: 'text', text: '你是一位网文作家。' }])
    expect(req.body.messages).toEqual([{ role: 'user', content: '第一段\n\n第二段' }])
    expect(req.body.stream).toBe(true)
    expect(req.body.max_tokens).toBe(12000)
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) expect(req.body).not.toHaveProperty(key)
    expect(req.cached).toBe(false)

    // 调用方要求的上限高于默认封顶时照调用方的
    expect(buildAnthropicRequest(model, [{ role: 'user', content: 'x' }], { maxTokens: 100000 }, false).body.max_tokens).toBe(100000)
  })

  it('Canon 上下文提到 system 开头并打上 cache_control，原位置留下同语言的指引', () => {
    const prompt = `你正在连载写作最新章节。\n\n【Canon 上下文】\n${markCacheable(longCanon)}\n\n【本章目标】推进主线`
    const req = buildAnthropicRequest(model, [
      { role: 'system', content: '你是一位网文作家。' },
      { role: 'user', content: prompt },
    ], { maxTokens: 4000 }, false)

    expect(req.cached).toBe(true)
    const [canonBlock, roleBlock] = req.body.system!
    expect(canonBlock.cache_control).toEqual({ type: 'ephemeral' })
    expect(canonBlock.text).toContain(longCanon)
    expect(canonBlock.text.startsWith('【Canon 上下文')).toBe(true)
    expect(roleBlock).toEqual({ type: 'text', text: '你是一位网文作家。' })

    const user = req.body.messages[0].content
    expect(user).not.toContain(longCanon)
    expect(user).toContain('Canon 上下文已放在系统提示开头')
    expect(user).toContain('【本章目标】推进主线')
    expect(user).not.toContain(CACHEABLE_START)
    expect(user).not.toContain(CACHEABLE_END)
  })

  it('同一份 Canon 在不同模板里得到完全相同的缓存前缀（写稿 / 修稿可共用缓存）', () => {
    const draft = buildAnthropicRequest(model, [
      { role: 'system', content: '你是一位网文作家。' },
      { role: 'user', content: `写稿：\n${markCacheable(longCanon)}\n正文要求…` },
    ], { maxTokens: 4000 }, true)
    const refine = buildAnthropicRequest(model, [
      { role: 'system', content: '你是一位文学编辑。' },
      { role: 'user', content: `修稿：\n${markCacheable(longCanon)}\n审稿报告…` },
    ], { maxTokens: 4000 }, true)
    expect(draft.body.system![0]).toEqual(refine.body.system![0])
  })

  it('英文 / 俄文提示词用对应语言的标题与指引；Canon 太短时不提出来，只去掉标记', () => {
    const en = buildAnthropicRequest(model, [{ role: 'user', content: `You are writing.\n${markCacheable(longCanon)}\nGoal` }], {}, false)
    expect(en.body.system![0].text.startsWith('[Canon Context')).toBe(true)
    expect(en.body.messages[0].content).toContain('The Canon Context is provided at the beginning')

    const ru = buildAnthropicRequest(model, [{ role: 'user', content: `Вы пишете главу.\n${markCacheable(longCanon)}\nЦель` }], {}, false)
    expect(ru.body.system![0].text.startsWith('[Контекст канона')).toBe(true)

    const short = buildAnthropicRequest(model, [{ role: 'user', content: `前言${markCacheable('很短的设定')}后文` }], {}, false)
    expect(short.cached).toBe(false)
    expect(short.body.system).toBeUndefined()
    expect(short.body.messages[0].content).toBe('前言很短的设定后文')
  })
})

describe('Anthropic 响应解析', () => {
  it('流式：跳过 thinking 块，只转发正文；合并累计用量（含缓存写入 / 命中）', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await runStream(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想想' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'ping' },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '林轩' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '拔剑。' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
      { type: 'message_stop' },
    ]))
    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(['林轩', '拔剑。'])
    expect(result.done?.text).toBe('林轩拔剑。')
    expect(result.done?.usage).toEqual({ promptTokens: 3020, completionTokens: 42, totalTokens: 3062 })
  })

  it('流式：error 事件带上错误类型（overloaded 可被渲染层识别为可重试）；拒答报错', async () => {
    const overloaded = await runStream(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]))
    expect(overloaded.error).toContain('overloaded_error')

    const refused = await runStream(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'cyber' } }, usage: { output_tokens: 0 } },
    ]))
    expect(refused.error).toContain('refusal')
    expect(refused.error).toContain('cyber')
  })

  it('非流式：只取 text 块；HTTP 错误带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '你好' }],
      usage: { input_tokens: 10, output_tokens: 2 },
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const ok = await new AnthropicProvider().generate(model, [{ role: 'user', content: 'hi' }], { temperature: 0.7, maxTokens: 10 })
    expect(ok).toEqual({ success: true, content: '你好', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
      status: 429, headers: { 'retry-after': '7' },
    })))
    const limited = await new AnthropicProvider().generate(model, [{ role: 'user', content: 'hi' }], { temperature: 0.7, maxTokens: 10 })
    expect(limited.success).toBe(false)
    expect(limited.error).toContain('(429)')
    expect(limited.error).toContain('retry-after=7s')
  })
})
