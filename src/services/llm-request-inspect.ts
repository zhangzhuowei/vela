export type LlmChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type RequestSlot = 'system' | 'history' | 'post_history'

export type AnnotatedRequestMessage = LlmChatMessage & {
  index: number
  chars: number
  slot: RequestSlot
}

export const REQUEST_TRACE_LIMIT = 8

/** 把指导钉在整段对话之后。末条已是 user 则合并，避免连续两条 user（中转常因此挂死流）。 */
export function pinPostHistory(messages: LlmChatMessage[], postHistory?: string): LlmChatMessage[] {
  const text = postHistory?.trim()
  if (!text) return messages
  const last = messages[messages.length - 1]
  if (last?.role === 'user') {
    return [...messages.slice(0, -1), { role: 'user', content: `${last.content}\n\n${text}` }]
  }
  return [...messages, { role: 'user', content: text }]
}

/** 写稿管线：system 角色 + 本轮 user，再按槽位挂 Mod。 */
export function pinWorkflowMessages(
  systemPrompt: string,
  userPrompt: string,
  extras?: { systemAppend?: string; postHistory?: string }
): LlmChatMessage[] {
  const system = [systemPrompt, extras?.systemAppend]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join('\n\n')
  return pinPostHistory(
    [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    extras?.postHistory
  )
}

/** 按贴底原文标注消息槽位：末条 user 等于或包含任一段 pin 时标为 post_history。 */
export function annotateRequestMessages(
  messages: LlmChatMessage[],
  postHistory?: string | string[]
): AnnotatedRequestMessage[] {
  const pins = (Array.isArray(postHistory) ? postHistory : [postHistory ?? ''])
    .map((s) => s.trim())
    .filter(Boolean)
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]
  const lastIsPin = Boolean(
    last?.role === 'user' &&
      pins.some((pin) => last.content === pin || last.content.includes(pin))
  )
  return messages.map((m, index) => {
    let slot: RequestSlot = 'history'
    if (index === 0 && m.role === 'system') slot = 'system'
    if (lastIsPin && index === lastIdx) slot = 'post_history'
    return {
      ...m,
      index,
      chars: m.content.replace(/\s/g, '').length,
      slot,
    }
  })
}

/** 新请求插到最前，超出上限丢掉最旧的。 */
export function prependRequestTrace<T>(existing: T[], next: T, limit = REQUEST_TRACE_LIMIT): T[] {
  return [next, ...existing].slice(0, limit)
}
