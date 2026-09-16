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
