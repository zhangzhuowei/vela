/**
 * 对话创作模式 — <state> 状态补丁协议
 *
 * 模型在场景正文之后输出一段：
 *   <state>{"角色名": {"location": "...", "mentalState": "..."}}</state>
 * 只包含发生变化的字段。本模块负责剥离与合并。
 */
import type { WorkingState } from '../../shared/ipc-channels'

const STATE_RE = /<state>\s*([\s\S]*?)\s*<\/state>/i
// 闭合标签可选：部分模型只写 <options> 不写 </options>，未闭合时吃到文本末尾
const OPTIONS_RE = /<options>\s*([\s\S]*?)(?:\s*<\/options>|$)/i
const OPTION_LINE_RE = /^\s*(?:\d+\s*[.)、:：]|[-*•])\s*(.+)$/
/** 模型把格式合同念出来：把 <state> 写成《state》并跟「占位不写」 */
const STATE_LEAK_RE = /(?:^|\n)\s*[《<]state[》>]\s*占位[^\n]*/gi
const PLACEHOLDER_REFUSAL_RE = /(?:^|\n)\s*占位不写[。.]?\s*/g

/** 去掉模型照抄的格式说明残片，避免写进正文气泡。 */
export function stripProtocolLeak(text: string): string {
  return text
    .replace(STATE_LEAK_RE, '')
    .replace(PLACEHOLDER_REFUSAL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从模型输出中剥离正文与状态补丁；坏 JSON 容错为空补丁 */
export function splitProseAndState(raw: string): { prose: string; patch: WorkingState } {
  const text = raw ?? ''
  const match = text.match(STATE_RE)
  if (!match) return { prose: stripProtocolLeak(stripOptionHints(text)), patch: {} }

  const prose = stripProtocolLeak(
    stripOptionHints(
      (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim()
    )
  )
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

function stripOptionHints(text: string): string {
  return text.replace(OPTIONS_RE, '').trim()
}

/** 从模型输出的 <options> 块解析下一轮控场选项；无块时返回空数组 */
export function parseOptionHints(raw: string, limit?: number): string[] {
  const match = (raw ?? '').match(OPTIONS_RE)
  if (!match) return []
  const items: string[] = []
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const numbered = trimmed.match(OPTION_LINE_RE)
    const text = (numbered ? numbered[1] : trimmed).trim()
    if (text) items.push(text)
  }
  if (limit && limit > 0) return items.slice(0, limit)
  return items
}

/** 把解析后的选项规范成可落库的 <options> 块；空列表返回空串 */
export function formatOptionHints(options: string[]): string {
  const items = options.map((s) => s.trim()).filter(Boolean)
  if (items.length === 0) return ''
  return `<options>\n${items.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n</options>`
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
