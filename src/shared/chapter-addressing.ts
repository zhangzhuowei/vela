/**
 * 章号地址空间：正文 1～9999；线 id 的章 = id × 10000 + 线内序号。
 * 所有「按章号筛」的读操作都应经过 visibilityFor / isVisible / visibilityWhere。
 */
export const BRANCH_BASE = 10000
export const MAIN_MAX = BRANCH_BASE - 1

export type BranchKind = 'extra' | 'if'
export interface BranchLike { id: number; kind: BranchKind; name: string; anchorChapter: number }

export interface ChapterVisibility {
  /** 可见的正文上限（含）；0 = 看不到任何正文章 */
  mainUpTo: number
  /** 0 = 正文 */
  branchId: number
  /** 本线可见范围 [branchFrom, branchUpTo]；from > upTo 表示空 */
  branchFrom: number
  branchUpTo: number
}

export function branchIdOf(n: number): number {
  return n > 0 ? Math.floor(n / BRANCH_BASE) : 0
}
export function localIndexOf(n: number): number {
  return n > 0 ? n % BRANCH_BASE : n
}
export function toChapterNumber(branchId: number, localIndex: number): number {
  if (!Number.isInteger(localIndex) || localIndex < 1 || localIndex >= BRANCH_BASE) {
    throw new Error(`线内序号越界：${localIndex}`)
  }
  return branchId * BRANCH_BASE + localIndex
}
export function isMainChapter(n: number): boolean {
  return n > 0 && n <= MAIN_MAX
}

export function branchOf(n: number, branches: BranchLike[]): BranchLike | null {
  const id = branchIdOf(n)
  if (id === 0) return null
  const b = branches.find((x) => x.id === id)
  if (!b) throw new Error(`章号 ${n} 所属的线 ${id} 不存在`)
  return b
}

export function visibilityFor(n: number, branches: BranchLike[]): ChapterVisibility {
  const b = branchOf(n, branches)
  if (!b) return { mainUpTo: n - 1, branchId: 0, branchFrom: 0, branchUpTo: 0 }
  const base = b.id * BRANCH_BASE
  return { mainUpTo: b.anchorChapter, branchId: b.id, branchFrom: base + 1, branchUpTo: n - 1 }
}

export function isVisible(candidate: number, v: ChapterVisibility): boolean {
  if (candidate <= 0) return v.branchId === 0
  if (candidate <= MAIN_MAX) return candidate <= v.mainUpTo
  return candidate >= v.branchFrom && candidate <= v.branchUpTo
}

/** 0 = 开书即有：正文全程可见；锚点 > 0 的线可见；前传不可见。 */
export function isOriginVisible(v: ChapterVisibility): boolean {
  return v.branchId === 0 || v.mainUpTo > 0
}

/** 时间戳字段（started_at / introduced_at / resolved_at）。0 按开书即有处理，与章号 0 不同。 */
export function isTimestampVisible(n: number, v: ChapterVisibility): boolean {
  if (n <= 0) return isOriginVisible(v)
  return isVisible(n, v)
}

export interface PlotLineLike {
  startedAt: number
  lastAdvancedAt?: number
  resolvedAt?: number | null
  currentState?: string
  status?: string
}

/** 在该可见性窗口内已开线且尚未了结（含正史后来才 resolve、对线内仍算未结的情况）。 */
export function isPlotLineOpenAt(line: PlotLineLike, v: ChapterVisibility): boolean {
  if (!isTimestampVisible(line.startedAt, v)) return false
  const resolved = line.resolvedAt ?? 0
  if (resolved > 0 && isTimestampVisible(resolved, v)) return false
  return true
}

/** 遮盖锚点之后才推进的 currentState；后来才了结的线对外仍显示 active。 */
export function redactPlotLineForVisibility<T extends PlotLineLike>(line: T, v: ChapterVisibility): T {
  let next = line
  const resolved = line.resolvedAt ?? 0
  if (resolved > 0 && !isTimestampVisible(resolved, v) && line.status === 'resolved') {
    next = { ...next, status: 'active' }
  }
  const advanced = line.lastAdvancedAt ?? 0
  if (advanced > 0 && !isTimestampVisible(advanced, v)) {
    next = { ...next, currentState: '', lastAdvancedAt: line.startedAt }
  }
  return next
}

export function previousChapterNumber(n: number, branches: BranchLike[]): number | null {
  const b = branchOf(n, branches)
  if (!b) return n > 1 ? n - 1 : null
  if (localIndexOf(n) === 1) return b.anchorChapter > 0 ? b.anchorChapter : null
  return n - 1
}

/** 写稿守卫用：上一章必须已定稿。未知线不回退到 n-1（避免去查 10000）。 */
export function requiredPreviousChapter(n: number, branches: BranchLike[]): number | null {
  if (!n) return null
  try {
    return previousChapterNumber(n, branches)
  } catch {
    return isMainChapter(n) && n > 1 ? n - 1 : null
  }
}

/** 全书/本线真正的开篇：正文第 1 章，或锚点 0 的线内第 1 章。 */
export function isStoryOpening(n: number, v: ChapterVisibility): boolean {
  if (v.branchId === 0) return n <= 1
  return v.branchUpTo < v.branchFrom && v.mainUpTo <= 0
}

export function displayChapterName(n: number, branches: BranchLike[], title = ''): string {
  const suffix = title ? ` ${title}` : ''
  const b = branchOf(n, branches)
  if (!b) return `第${n}章${suffix}`
  const local = localIndexOf(n)
  return b.kind === 'extra' ? `番外·${b.name} ${local}${suffix}` : `IF·${b.name} 第${local}章${suffix}`
}

export function displayChapterNameSafe(n: number, branches: BranchLike[], title = ''): string {
  try {
    return displayChapterName(n, branches, title)
  } catch {
    return `第${n}章${title ? ` ${title}` : ''}`
  }
}

export function chapterFileName(n: number, branches: BranchLike[], title = ''): string {
  const safe = title.replace(/[/\\:*?"<>|]/g, '_')
  return `${displayChapterNameSafe(n, branches, safe)}.txt`
}

export function visibilityWhere(
  col: string,
  v: ChapterVisibility,
  opts?: { origin?: boolean },
): { sql: string; params: number[] } {
  if (v.branchId === 0) return { sql: `(${col} <= ?)`, params: [v.mainUpTo] }
  const range = {
    sql: `((${col} > 0 AND ${col} <= ?) OR (${col} BETWEEN ? AND ?))`,
    params: [v.mainUpTo, v.branchFrom, v.branchUpTo],
  }
  if (opts?.origin && isOriginVisible(v)) {
    return { sql: `(${col} <= 0 OR ${range.sql})`, params: range.params }
  }
  return range
}
