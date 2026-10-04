import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import { ModelProfile } from '../../src/shared/ipc-channels'
import {
  createTimeoutController, withRequestTimeout, timeoutMessage, httpErrorMessage,
  CONNECT_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS,
} from './http'

export class OpenAIProvider implements ILLMProvider {
  private supportsResponseFormat(model: ModelProfile): boolean {
    // Ollama Cloud does not support constrained structured output. Keep the
    // requested format in the prompt and validate the result in the caller.
    if (model.provider !== 'ollama') return true
    return !/[:-]cloud$/i.test(model.modelName) && !/^https?:\/\/(?:api\.)?ollama\.com(?:\/|$)/i.test(model.baseUrl)
  }
  private applyThinkingOption(body: Record<string, unknown>, model: ModelProfile, thinking?: boolean) {
    if (thinking === undefined) return
    if (model.provider === 'ollama') {
      // Ollama's OpenAI-compatible endpoint uses reasoning_effort, not its native think field.
      body.reasoning_effort = thinking ? 'high' : 'none'
    } else if (model.provider === 'deepseek' || thinking) {
      body.thinking = { type: thinking ? 'enabled' : 'disabled' }
    }
  }

  private buildUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '')
    // 已包含完整路径
    if (base.endsWith('/chat/completions')) {
      return base
    }
    // 已包含 /chat 但缺 /completions
    if (base.endsWith('/chat')) {
      return `${base}/completions`
    }
    // 已包含版本号路径（/v1, /v4 等），直接补全 chat/completions
    if (/\/v\d+$/.test(base)) {
      return `${base}/chat/completions`
    }
    // 无版本号路径，补全 /v1/chat/completions
    return `${base}/v1/chat/completions`
  }

  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    const url = this.buildUrl(model.baseUrl)

    const body: Record<string, unknown> = {
      model: model.modelName,
      messages,
      max_tokens: opts.maxTokens ?? model.maxTokens,
      stream: false,
    }

    // 思考模式下 temperature/top_p 等参数不生效（DeepSeek 会静默忽略），仅在非思考模式下传递
    if (opts.thinking) {
      // thinking 参数直接放在请求体顶层（非 extra_body，那是 OpenAI SDK 层概念）
      this.applyThinkingOption(body, model, true)
    } else {
      this.applyThinkingOption(body, model, opts.thinking)
      if (!opts.responseFormat) body.temperature = opts.temperature ?? model.temperature
    }

    if (opts.responseFormat && this.supportsResponseFormat(model)) body.response_format = opts.responseFormat

    type ChatCompletion = {
      choices: Array<{ finish_reason?: string; message: { content: string; reasoning_content?: string } }>
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }
    let data: ChatCompletion
    try {
      // 超时覆盖整个请求（含读完响应体），服务端挂住时不会让 invoke 永远不返回
      const result = await withRequestTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${model.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        })
        if (!res.ok) {
          return { ok: false as const, error: httpErrorMessage('API 调用失败', res, await res.text()) }
        }
        return { ok: true as const, data: await res.json() as ChatCompletion }
      })
      if (!result.ok) return { success: false, content: '', error: result.error }
      data = result.data
    } catch (error) {
      return { success: false, content: '', error: error instanceof Error ? error.message : String(error) }
    }

    if (data.choices?.[0]?.finish_reason === 'length') return { success: false, content: '', error: '模型输出达到长度上限，结果不完整，未提交本轮操作。请分段改写或增加模型输出上限。' }
    let finalContent = data.choices?.[0]?.message?.content ?? ''
    // Some Ollama/cloud adapters omit the opening thinking delimiter.
    finalContent = finalContent.replace(/^[\s\S]*<\/think>/i, '')
    finalContent = finalContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()

    return {
      success: true,
      content: finalContent,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    // 连接阶段用连接超时；收到响应头后切换为流空闲超时，每收到一段数据重新计时。
    // 与用户取消信号合并：两者任一触发都会中止请求
    const tc = createTimeoutController(CONNECT_TIMEOUT_MS, opts.signal)
    let streaming = false
    try {
      const url = this.buildUrl(model.baseUrl)

      const body: Record<string, unknown> = {
        model: model.modelName,
        messages,
        max_tokens: opts.maxTokens ?? model.maxTokens,
        stream: true,
        // 流式默认不返回 token 用量，须显式索取；服务商若不支持会忽略该字段，
        // 此时 usage 保持 undefined，由调用方按 0 记账。
        stream_options: { include_usage: true },
      }

      // 思考模式下 temperature/top_p 等参数不生效（DeepSeek 会静默忽略），仅在非思考模式下传递
      this.applyThinkingOption(body, model, opts.thinking)
      // Some JSON gateways reject custom temperature; thinking mode also owns its sampling settings.
      if (!opts.thinking && !opts.responseFormat) {
        body.temperature = opts.temperature ?? model.temperature
      }

      if (opts.responseFormat && this.supportsResponseFormat(model)) body.response_format = opts.responseFormat

      const send = () => fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: tc.signal,
      })

      let res = await send()

      // stream_options 只是为了取 token 用量。若服务商不认这个字段而返回 400，
      // 去掉它重试一次——宁可没有用量统计，也不能让生成失败。
      if (res.status === 400 && body.stream_options) {
        delete body.stream_options
        res = await send()
      }

      if (!res.ok) {
        const text = await res.text()
        opts.onError(httpErrorMessage('API 调用失败', res, text))
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取响应流')
        return
      }

      streaming = true
      tc.reset(STREAM_IDLE_TIMEOUT_MS)

      const decoder = new TextDecoder()
      let fullText = ''
      let isThinking = false
      // include_usage 时用量随最后一个数据包到达（该包 choices 为空数组）
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
      let truncated = false

      const handleData = (json: string) => {
        if (json === '[DONE]') return
        try {
          const parsed = JSON.parse(json) as {
            choices: Array<{ finish_reason?: string; delta?: { content?: string, reasoning_content?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          }

          // include_usage 的用量随最后一个数据包到达（该包 choices 为空数组）
          if (parsed.usage) {
            const p = parsed.usage.prompt_tokens ?? 0
            const c = parsed.usage.completion_tokens ?? 0
            usage = {
              promptTokens: p,
              completionTokens: c,
              totalTokens: parsed.usage.total_tokens ?? p + c,
            }
          }
          if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true

          const delta = parsed.choices?.[0]?.delta

          let emitChunk = ''

          // 如果存在思维链内容
          if (delta?.reasoning_content) {
            if (!isThinking) {
              isThinking = true
              emitChunk += '<think>\n'
            }
            emitChunk += delta.reasoning_content
          } 
          
          // 如果开始输出正文
          if (delta?.content !== undefined && delta?.content !== null) {
            if (isThinking) {
              isThinking = false
              emitChunk += '\n</think>\n\n'
            }
            if (delta?.content) {
              emitChunk += delta.content
            }
          }

          if (emitChunk) {
            fullText += emitChunk
            opts.onChunk(emitChunk)
          }
        } catch {
          // ignore
        }
      }

      // SSE 事件可能跨越网络分片边界，跨块保留未完整行，避免事件被丢弃
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // 收到数据：流空闲超时重新计时
        tc.reset()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim() // 兼容 \r\n 行尾
          if (trimmed.startsWith('data: ')) {
            handleData(trimmed.slice(6).trim())
          }
        }
      }

      // 流末尾最后一条事件可能没有换行结尾
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data: ')) {
          handleData(trimmed.slice(6).trim())
        }
      }

      if (isThinking) {
        const closeTag = '\n</think>\n\n'
        fullText += closeTag
        opts.onChunk(closeTag)
      }

      if (truncated) {
        opts.onError('模型输出达到长度上限，结果不完整，未提交本轮操作。请分段改写或增加模型输出上限。')
        return
      }
      opts.onDone(fullText.replace(/^[\s\S]*<\/think>/i, '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim(), usage)
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
