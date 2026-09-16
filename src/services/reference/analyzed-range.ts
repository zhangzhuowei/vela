/** 从第 1 章起连续成功的最后一章；没有第 1 章则为 0。 */
export function contiguousAnalyzedTo(okChapters: number[]): number {
  const ok = new Set(okChapters)
  let n = 0
  while (ok.has(n + 1)) n++
  return n
}

export function nextDigestRange(
  pending: number[],
  totalChapters: number,
  batchSize = 200,
): { from: number; to: number } | null {
  if (pending.length === 0 || totalChapters < 1) return null
  const from = pending[0]
  const to = Math.min(totalChapters, from + batchSize - 1)
  if (to < from) return null
  return { from, to }
}

/** 指定 force 时重跑这些章（即使已成功）；否则只跑尚未 ok 的 pending。 */
export function chapterRunQueue(pending: number[], forceChapters?: number[]): number[] {
  if (forceChapters && forceChapters.length > 0) return [...new Set(forceChapters)]
  return pending
}

/** 根据当前 L0 成败收口进度；进程崩溃后从 running 恢复也走这里。 */
export function settleDigestWorkProgress(
  okChapters: number[],
  anyFailed: boolean,
  leftoverCount: number,
): { analyzedFrom: number; analyzedTo: number; status: 'idle' | 'error' | 'done' } {
  const analyzedTo = contiguousAnalyzedTo(okChapters)
  return {
    analyzedFrom: analyzedTo > 0 ? 1 : 0,
    analyzedTo,
    status: anyFailed ? 'error' : leftoverCount > 0 ? 'idle' : 'done',
  }
}
