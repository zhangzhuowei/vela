/**
 * 对话创作模式 — <state> 状态补丁协议
 *
 * 模型在场景正文之后输出一段：
 *   <state>{"角色名": {"location": "...", "mentalState": "..."}}</state>
 * 只包含发生变化的字段。本模块负责剥离与合并。
 */
import type { WorkingState } from '../../shared/ipc-channels'

const STATE_RE = /<state>\s*([\s\S]*?)\s*<\/state>/i

/** 从模型输出中剥离正文与状态补丁；坏 JSON 容错为空补丁 */
export function splitProseAndState(raw: string): { prose: string; patch: WorkingState } {
  const text = raw ?? ''
  const match = text.match(STATE_RE)
  if (!match) return { prose: text.trim(), patch: {} }

  const prose = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim()
  let patch: WorkingState = {}
  try {
    const parsed = JSON.parse(match[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      patch = {}
      for (const [name, fields] of Object.entries(parsed)) {
        if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
          patch[name] = Object.fromEntries(
            Object.entries(fields as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
          )
        }
      }
    }
  } catch {
    patch = {}
  }
  return { prose, patch }
}

/**
 * 把补丁合并进章级进行中状态。
 * 只接受已知角色；空白值不覆盖已有值。
 */
export function mergeWorkingState(
  current: WorkingState,
  patch: WorkingState,
  validNames: string[]
): WorkingState {
  const valid = new Set(validNames)
  const next: WorkingState = {}
  for (const [name, fields] of Object.entries(current)) {
    next[name] = { ...fields }
  }
  for (const [name, fields] of Object.entries(patch)) {
    if (!valid.has(name)) continue
    const merged = { ...(next[name] ?? {}) }
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string' && value.trim() !== '') {
        merged[key] = value
      }
    }
    next[name] = merged
  }
  return next
}
