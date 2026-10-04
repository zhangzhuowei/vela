/**
 * 不隶属于某个命令的 LLM 调用（定稿后处理、架构角色卡提取等）也走命令基类：
 * 重试退避（含 Retry-After）、备用模型链、调用记账与取消都与命令内的调用一致。
 *
 * 此前这些路径直接调 generateStream：不重试、不记账、不能取消，
 * 「章节要点」这种关键步骤遇到一次限流就失败，下一章的前置校验随之不过，整批停下。
 */
import { BaseWorkflowCommand } from './base-command'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'

class StandaloneLLMCaller extends BaseWorkflowCommand<void> {
  constructor(private readonly purpose: string) {
    super()
  }

  /** 统计面板里按调用方区分用量 */
  protected get callPurpose(): string {
    return this.purpose
  }

  async execute(): Promise<void> {
    /* 仅作为调用器使用，不单独执行 */
  }

  run(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext,
    modelId?: string,
  ): Promise<string> {
    return this.callLLM(prompt, systemPrompt, callbacks, options, context, modelId)
  }
}

/** 调用方可能只提供部分回调（如只有日志与流式输出），缺的补成空实现 */
type PartialCallbacks = Pick<StepCallbacks, 'appendText'> & Partial<StepCallbacks>

function completeCallbacks(cb: PartialCallbacks): StepCallbacks {
  return {
    log: cb.log ?? (() => { }),
    setProgress: cb.setProgress ?? (() => { }),
    appendText: cb.appendText,
  }
}

/**
 * 发起一次独立的 LLM 调用，返回去掉 <think> 标签后的完整文本。
 * @param purpose 用量统计里的用途标签
 * @param context 所属工作流的上下文（可选）：传入后用户取消能中断进行中的请求
 */
export function callLLMStandalone(
  prompt: string,
  systemPrompt: string,
  callbacks: PartialCallbacks,
  purpose: string,
  options?: { responseFormat?: { type: string }; thinking?: boolean },
  context?: WorkflowContext,
  modelId?: string,
): Promise<string> {
  return new StandaloneLLMCaller(purpose).run(prompt, systemPrompt, completeCallbacks(callbacks), options, context, modelId)
}
