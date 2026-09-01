export type LlmChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type RequestSlot = 'system' | 'history' | 'post_history'

export type AnnotatedRequestMessage = LlmChatMessage & {
  index: number
  chars: number
  slot: RequestSlot
}

export const REQUEST_TRACE_LIMIT = 8

/** 按贴底原文标注消息槽位：末条 user 与启用 Mod 一致时标为 post_history。 */
export function annotateRequestMessages(
  messages: LlmChatMessage[],
  postHistory?: string
): AnnotatedRequestMessage[] {
  const pin = postHistory?.trim() ?? ''
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]
  const lastIsPin = Boolean(pin && last?.role === 'user' && last.content === pin)
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
