const MIN = 3
const MAX = 5

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return MIN
  return Math.min(MAX, Math.max(MIN, Math.round(n)))
}

/** 对话选项个数：书级默认 × 当场覆盖 → 实际注入提示词的条数 */
export function resolveOptionCount(params: {
  bookEnabled?: boolean
  bookCount?: number
  /** null = 跟随书；0 = 当场关掉；3/4/5 = 当场覆盖 */
  localOverride?: number | null
}): number {
  if (params.localOverride != null) {
    if (params.localOverride <= 0) return 0
    return clampCount(params.localOverride)
  }
  if (!params.bookEnabled) return 0
  return clampCount(params.bookCount ?? MIN)
}
