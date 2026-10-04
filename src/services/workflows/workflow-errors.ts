/**
 * 工作流错误类型
 *
 * 取消判断用错误类型而不是匹配错误文案：文案随界面语言变化（英文是 "Workflow cancelled"），
 * 按「取消」二字匹配在 en/ru 界面下会失效，取消被当成普通失败吞掉或触发重试。
 */
import i18n from '../../i18n'

/** 工作流被用户取消 */
export class WorkflowCancelledError extends Error {
  readonly isWorkflowCancelled = true

  constructor(message?: string) {
    super(message ?? i18n.t('base.workflowCancelled', { ns: 'commands' }))
    this.name = 'WorkflowCancelledError'
  }
}

/**
 * 是否为「用户取消」。
 * 优先按类型判断；兼容仍在抛普通 Error 的旧代码路径，再按三种界面语言的取消文案兜底。
 */
export function isWorkflowCancelled(e: unknown): boolean {
  if (e instanceof WorkflowCancelledError) return true
  if (e && typeof e === 'object' && (e as { isWorkflowCancelled?: unknown }).isWorkflowCancelled === true) return true
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return msg === i18n.t('base.workflowCancelled', { ns: 'commands' }) || /工作流已取消|workflow cancell?ed|процесс отмен/i.test(msg)
}

/** 若已取消则抛出 WorkflowCancelledError */
export function throwIfCancelled(context: { cancelled: boolean } | undefined): void {
  if (context?.cancelled) throw new WorkflowCancelledError()
}
