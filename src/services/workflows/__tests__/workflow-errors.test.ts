import { describe, it, expect } from 'vitest'
import i18n from '../../../i18n'
import { WorkflowCancelledError, isWorkflowCancelled, throwIfCancelled } from '../workflow-errors'

describe('isWorkflowCancelled', () => {
  it('按类型识别取消错误', () => {
    expect(isWorkflowCancelled(new WorkflowCancelledError())).toBe(true)
  })

  it('三种界面语言下的取消文案都能识别（兼容仍抛普通 Error 的旧路径）', () => {
    expect(isWorkflowCancelled(new Error('工作流已取消'))).toBe(true)
    expect(isWorkflowCancelled(new Error('Workflow cancelled'))).toBe(true)
    expect(isWorkflowCancelled(new Error('Рабочий процесс отменён'))).toBe(true)
  })

  it('当前界面语言的取消文案能识别', async () => {
    const prev = i18n.language
    try {
      await i18n.changeLanguage('en')
      expect(isWorkflowCancelled(new WorkflowCancelledError())).toBe(true)
      expect(new WorkflowCancelledError().message).toBe('Workflow cancelled')
    } finally {
      await i18n.changeLanguage(prev)
    }
  })

  it('普通错误不算取消', () => {
    expect(isWorkflowCancelled(new Error('API 调用失败 (429): rate limit'))).toBe(false)
    expect(isWorkflowCancelled(new Error('请求超时（timeout）'))).toBe(false)
    expect(isWorkflowCancelled(undefined)).toBe(false)
  })
})

describe('throwIfCancelled', () => {
  it('已取消时抛 WorkflowCancelledError，否则什么都不做', () => {
    expect(() => throwIfCancelled({ cancelled: true })).toThrow(WorkflowCancelledError)
    expect(() => throwIfCancelled({ cancelled: false })).not.toThrow()
    expect(() => throwIfCancelled(undefined)).not.toThrow()
  })
})
