import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'
import { parseJSONWithRepair } from '../json-repair'

export interface CommandExecuteParams {
  step: unknown
  context: WorkflowContext
  callbacks: StepCallbacks
}

/**
 * 工作流执行环节的抽象基类 (Command Pattern)
 * 将原本混乱的 workflow 闭包拆分为可独立测试、状态解耦的命令单元。
 */
export abstract class BaseWorkflowCommand<TResult = string> {
  
  /** 抽象执行入口 */
  abstract execute(params: CommandExecuteParams): Promise<TResult>

  /** 单次 LLM 调用的重试上限（不含首次） */
  protected maxLLMRetries = 2

  /**
   * 调用 LLM（带瞬时错误自动重试）。
   * - 对 503/429/超时/服务器繁忙/网络抖动等可恢复错误做指数退避重试；
   * - 对用户取消、鉴权错误（401/403）、其他不可恢复错误立即抛出。
   * 签名与行为对外保持不变，所有子命令自动获益。
   */
  protected async callLLM(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext,
    primaryModelId?: string
  ): Promise<string> {
    const chain = this.buildModelChain(primaryModelId)
    let lastErr: unknown

    for (let ci = 0; ci < chain.length; ci++) {
      const modelId = chain[ci]
      if (ci > 0) callbacks.log(`↩️ 上一模型持续失败，改用备用模型：${this.modelLabel(modelId)}`)

      for (let attempt = 0; attempt <= this.maxLLMRetries; attempt++) {
        if (context?.cancelled) throw new Error('工作流已取消')
        try {
          return await this.invokeLLMStreamOnce(prompt, systemPrompt, callbacks, options, context, modelId)
        } catch (e) {
          lastErr = e
          const msg = e instanceof Error ? e.message : String(e)
          // 用户取消 → 立即中止整个链
          if (msg.includes('取消')) throw e
          const retriable = this.isRetriableError(msg)
          const auth = this.isAuthError(msg)
          // 不可恢复且非鉴权错误（如 400/解析错误）→ 换模型也无意义，直接抛
          if (!retriable && !auth) throw e
          // 可恢复错误且还有重试机会 → 退避后重试同一模型
          if (retriable && attempt < this.maxLLMRetries) {
            const waitMs = 1500 * (attempt + 1)
            callbacks.log(`⚠️ LLM 调用失败：${msg}；${Math.round(waitMs / 1000)}s 后重试 (${attempt + 1}/${this.maxLLMRetries})...`)
            await new Promise((r) => setTimeout(r, waitMs))
            continue
          }
          // 重试用尽（或鉴权错误）→ 跳出，尝试链中下一个备用模型
          break
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /**
   * 构造模型尝试链：主模型在前（primary 指定则用它，否则用默认模型——
   * 用 undefined 让 generateStream 走默认，保持原行为）；其余已配置生成模型作为备用，
   * 备用中优先不同 base_url（不同服务商），以规避"同一家服务商同时繁忙/故障"。
   */
  private buildModelChain(primary?: string): Array<string | undefined> {
    const llmStore = useLLMStore.getState()
    // 主模型槽：指定了 primary 就用它，否则 undefined（=走默认模型）
    const chain: Array<string | undefined> = [primary]
    const models = llmStore.models
    if (models.length <= 1) return chain
    // 用于"排除自身 + 优选不同服务商"的基准：primary 或默认模型
    const primaryId = primary ?? llmStore.defaultModelId ?? undefined
    const primaryBase = primaryId ? models.find((m) => m.id === primaryId)?.baseUrl ?? '' : ''
    const others = models.filter((m) => m.id !== primaryId)
    const diffProvider = others.filter((m) => m.baseUrl !== primaryBase)
    const sameProvider = others.filter((m) => m.baseUrl === primaryBase)
    for (const m of [...diffProvider, ...sameProvider]) chain.push(m.id)
    return chain
  }

  /** 模型可读名（用于日志） */
  private modelLabel(modelId?: string): string {
    if (!modelId) return '默认模型'
    const m = useLLMStore.getState().models.find((x) => x.id === modelId)
    return m ? m.name : modelId
  }

  /**
   * 本次调用的用途标签，用于在统计面板里分辨 token 花在哪一步。
   * 默认取命令类名（GenerateDraftCommand → GenerateDraft），子命令可覆写成更可读的名字。
   */
  protected get callPurpose(): string {
    return this.constructor.name.replace(/Command$/, '')
  }

  /**
   * 上报一次 LLM 调用。成功与失败都记，否则出错的调用在统计里看不见。
   * 拿不到 usage（服务商不支持 include_usage）时按 0 记，宁可少 token 数也不丢这条记录。
   * 整个过程不 await、不抛错，绝不干扰生成主流程。
   */
  private logCall(
    modelId: string,
    startedAt: number,
    success: boolean,
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
    errorMessage?: string,
  ): void {
    void import('../../stats-service')
      .then(({ logLLMCall }) => logLLMCall({
        modelId,
        modelName: this.modelLabel(modelId || undefined),
        purpose: this.callPurpose,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        durationMs: Date.now() - startedAt,
        success,
        errorMessage,
      }))
      .catch(() => { /* 记账失败不影响生成 */ })
  }

  /** 可重试的瞬时错误：限流 / 服务器繁忙 / 超时 / 网络抖动 / 空响应 */
  protected isRetriableError(msg: string): boolean {
    return /\b(429|500|502|503|504)\b/.test(msg)
      || /too busy|busy now|timeout|timed out|rate.?limit|overload|ECONN|ETIMEDOUT|socket hang up|network|服务器繁忙|请求过于频繁|流式生成失败/i.test(msg)
  }

  /** 鉴权 / 权限错误：不应重试 */
  protected isAuthError(msg: string): boolean {
    return /\b(401|403)\b/.test(msg) || /unauthorized|invalid api key|forbidden|无效的?\s*api|鉴权失败/i.test(msg)
  }

  /** 获取 LLM 大模型连接代理（支持取消）— 单次调用，不含重试。modelId 为空时走默认模型 */
  private async invokeLLMStreamOnce(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext,
    modelId?: string
  ): Promise<string> {
    const llmStore = useLLMStore.getState()
    if (!modelId && !llmStore.defaultModelId) throw new Error('未配置默认 AI 模型')

    callbacks.setProgress(10)

    // 记账用：所有工作流的 LLM 调用都经由此处，在这里上报即可覆盖全部
    const startedAt = Date.now()
    const effectiveModelId = modelId ?? llmStore.defaultModelId ?? ''

    return new Promise((resolve, reject) => {
      let fullContent = ''
      let streamRequestId = ''

      // 取消监听：轮询 context.cancelled，主动中断 LLM 流
      let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
      if (context) {
        cancelCheckTimer = setInterval(() => {
          if (context.cancelled && streamRequestId) {
            clearInterval(cancelCheckTimer!)
            cancelCheckTimer = null
            llmStore.cancelGeneration(streamRequestId).catch(() => {})
            reject(new Error('工作流已取消'))
          }
        }, 200)
      }

      const cleanup = () => {
        if (cancelCheckTimer) {
          clearInterval(cancelCheckTimer)
          cancelCheckTimer = null
        }
      }

      llmStore.generateStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        {
          onChunk: (chunk) => {
            // 取消后不再追加输出
            if (context?.cancelled) return
            fullContent += chunk
            callbacks.appendText(chunk)
          },
          onDone: (text, usage) => {
            cleanup()
            // 取消后不 resolve，让 reject 生效
            if (context?.cancelled) {
              reject(new Error('工作流已取消'))
              return
            }
            this.logCall(effectiveModelId, startedAt, true, usage)
            callbacks.setProgress(90)
            const raw = text || fullContent
            const cleaned = this.stripThinkingTags(raw)
            resolve(cleaned)
          },
          onError: (err) => {
            cleanup()
            this.logCall(effectiveModelId, startedAt, false, undefined, err)
            reject(new Error(err || '流式生成失败'))
          }
        },
        modelId,
        options
      ).then(reqId => {
        streamRequestId = reqId
        // 如果在 generateStream 返回前已经取消
        if (context?.cancelled) {
          llmStore.cancelGeneration(reqId).catch(() => {})
          cleanup()
          reject(new Error('工作流已取消'))
        }
      }).catch(err => {
        cleanup()
        reject(err)
      })
    })
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext,
    primaryModelId?: string
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context, primaryModelId)
  }

  /**
   * 去除 DeepSeek 等模型的 <think> 标签，保证落盘纯净
   */
  protected stripThinkingTags(text: string): string {
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
  }

  /**
   * 全局容错 JSON 解析器
   * 自动剥离 Markdown ```json 代码块并处理尾随逗号等常见大模型幻觉
   */
  protected parseJSON<T>(text: string): T {
    try {
      // 1. 剥离 Markdown 块
      let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
      // 2. 如果存在前序引导语，截取第一把括号到最后一把括号
      const firstBrace = cleanText.indexOf('{')
      const firstBracket = cleanText.indexOf('[')
      const lastBrace = cleanText.lastIndexOf('}')
      const lastBracket = cleanText.lastIndexOf(']')

      if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        cleanText = cleanText.substring(firstBrace, lastBrace + 1)
      } else if (firstBracket !== -1 && lastBracket !== -1) {
        cleanText = cleanText.substring(firstBracket, lastBracket + 1)
      }
      
      return parseJSONWithRepair<T>(cleanText)
    } catch {
      throw new Error(`AI 返回的数据格式乱码，无法解析为有效层级结构。尝试解析内容末端: ${text.slice(-100)}`)
    }
  }

  /**
   * 解耦的事件驱动：通知 UI 层去更新资产树，而无需去 import Zustand Store
   */
  protected notifyRefresh(resources: EventPayloadMap['REFRESH_RESOURCE']['resources']) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources })
  }
}

