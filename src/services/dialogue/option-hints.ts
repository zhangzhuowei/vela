const MIN = 3
const MAX = 5

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return MIN
  return Math.min(MAX, Math.max(MIN, Math.round(n)))
}

/** 对话选项个数：书级总开关优先，开启后再套当场覆盖 */
export function resolveOptionCount(params: {
  bookEnabled?: boolean
  bookCount?: number
  /** null = 跟随书；0 = 当场关掉；3/4/5 = 当场覆盖。书级关闭时忽略 */
  localOverride?: number | null
}): number {
  if (!params.bookEnabled) return 0
  if (params.localOverride != null) {
    if (params.localOverride <= 0) return 0
    return clampCount(params.localOverride)
  }
  return clampCount(params.bookCount ?? MIN)
}

const DEFAULT_CHARS = 24
const MIN_CHARS = 8
const MAX_CHARS = 64

function clampChars(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_CHARS, Math.max(MIN_CHARS, Math.round(n)))
}

/** 选项单条字数上限：0 = 不限；书级默认 × 当场覆盖 */
export function resolveOptionMaxChars(params: {
  bookMaxChars?: number
  /** null = 跟随书；0 = 当场不限；正数 = 当场覆盖 */
  localOverride?: number | null
}): number {
  if (params.localOverride != null) {
    if (params.localOverride <= 0) return 0
    return clampChars(params.localOverride)
  }
  if (params.bookMaxChars == null) return DEFAULT_CHARS
  if (params.bookMaxChars <= 0) return 0
  return clampChars(params.bookMaxChars)
}
