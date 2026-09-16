/**
 * 篇幅闸门的纯函数：字数统计、下限比例、续写拼接去重。
 * 写稿管线（generate-draft）与对话模式（dialogue-service）共用同一套口径。
 */

/** 正文字数低于目标的这个比例才触发自动续写；可在全局设置里改 */
export const DEFAULT_LENGTH_FLOOR_RATIO = 0.85
/** 超过目标这个倍数只记警告，不裁；与写稿模板的 word_number_max（×1.25）一致 */
export const OVERSHOOT_RATIO = 1.25
/** 续写去重：只在已写正文末尾这么多字符里找重叠 */
const OVERLAP_WINDOW = 200
/** 重叠短于这个长度不算复述（避免把「他」「说。」这种巧合裁掉） */
const OVERLAP_MIN = 8

/** 正文字数：忽略空白，中文标点算字，与「中文字数」的直观认知对齐 */
export function countProseChars(text: string): number {
  return (text || '').replace(/\s/g, '').length
}

/** 接受 0.5～1 的小数或 50～100 的百分数；无效值回默认，越界夹到 [0.5, 1] */
export function resolveLengthFloorRatio(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LENGTH_FLOOR_RATIO
  const ratio = n >= 50 ? n / 100 : n
  return Math.min(1, Math.max(0.5, ratio))
}

export function lengthFloor(targetWords: number, ratio: number): number {
  return targetWords > 0 ? Math.round(targetWords * ratio) : 0
}

export function isOvershoot(current: number, targetWords: number, cap = OVERSHOOT_RATIO): boolean {
  return targetWords > 0 && current > Math.round(targetWords * cap)
}

/**
 * 模型续写时常把上文最后一两句重抄一遍再往下写。
 * 在已写正文末尾 OVERLAP_WINDOW 字内找「既是 existing 后缀、又是 added 前缀」的最长串，够长就从 added 里裁掉。
 */
export function trimOverlap(existing: string, added: string): string {
  const head = added.replace(/^\s+/, '')
  if (!head) return ''
  const tail = existing.replace(/\s+$/, '').slice(-OVERLAP_WINDOW)
  let best = 0
  const max = Math.min(tail.length, head.length)
  for (let len = max; len >= OVERLAP_MIN; len--) {
    if (tail.endsWith(head.slice(0, len))) { best = len; break }
  }
  return best > 0 ? head.slice(best).replace(/^\s+/, '') : head
}

/** 把续写接到已写正文后面：去重叠、空行分段；续写被裁空时原样返回 */
export function appendContinuation(existing: string, added: string): string {
  const piece = trimOverlap(existing, added).trim()
  if (!piece) return existing
  return `${existing.trimEnd()}\n\n${piece}`
}
