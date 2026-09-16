export interface StageDraft {
  title: string
  fromChapter: number
  toChapter: number
  goal: string
  antagonist: string
  entryHook: string
  exitPeak: string
  /** LLM 在批首标记：本段是否延续上一批最后一段 */
  continuesPrevious?: boolean
}
export type StageWithSeq = StageDraft & { seq: number }

export function batchByCount<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function looksLikeContinuation(prev: StageDraft, head: StageDraft): boolean {
  if (head.continuesPrevious) return true
  const strip = (t: string) => t.replace(/[（(]续[)）]|（续）|\s+/g, '')
  return strip(head.title) === strip(prev.title) && head.title !== ''
}

/** 单段重跑时从模型返回的多段里挑最贴当前起止章的一段。 */
export function pickStageDraft(drafts: StageDraft[], from: number, to: number): StageDraft | null {
  if (drafts.length === 0) return null
  const exact = drafts.find((d) => d.fromChapter === from && d.toChapter === to)
  if (exact) return exact
  const overlap = drafts.filter((d) => d.fromChapter <= to && d.toChapter >= from)
  if (overlap.length === 0) return drafts[0]
  return [...overlap].sort((a, b) => {
    const cover = (d: StageDraft) => Math.min(to, d.toChapter) - Math.max(from, d.fromChapter)
    return cover(b) - cover(a)
  })[0]
}

/**
 * 把新切出的阶段从锁定段的章范围里挖掉：整段在锁定范围内的丢弃，压边的裁掉，跨过去的劈成两段。
 * 归纳大纲只替换未锁定段，不做这一步会和锁定段重叠。
 */
export function excludeLockedRanges(
  drafts: StageDraft[],
  locked: Array<{ fromChapter: number; toChapter: number }>,
): StageDraft[] {
  if (locked.length === 0) return drafts
  const ranges = [...locked].sort((a, b) => a.fromChapter - b.fromChapter)
  const out: StageDraft[] = []
  for (const d of drafts) {
    let pieces: StageDraft[] = [d]
    for (const r of ranges) {
      const next: StageDraft[] = []
      for (const p of pieces) {
        if (p.toChapter < r.fromChapter || p.fromChapter > r.toChapter) { next.push(p); continue }
        if (p.fromChapter < r.fromChapter) next.push({ ...p, toChapter: r.fromChapter - 1 })
        if (p.toChapter > r.toChapter) next.push({ ...p, fromChapter: r.toChapter + 1 })
      }
      pieces = next
    }
    out.push(...pieces)
  }
  return out.sort((a, b) => a.fromChapter - b.fromChapter)
}

export function mergeStageBatches(batches: StageDraft[][]): StageWithSeq[] {
  const merged: StageDraft[] = []
  for (const batch of batches) {
    const sorted = [...batch].sort((a, b) => a.fromChapter - b.fromChapter)
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]
      const prev = merged[merged.length - 1]
      if (i === 0 && prev && looksLikeContinuation(prev, cur)) {
        prev.toChapter = Math.max(prev.toChapter, cur.toChapter)
        prev.exitPeak = cur.exitPeak || prev.exitPeak
        continue
      }
      merged.push({ ...cur, continuesPrevious: undefined })
    }
  }
  return merged.map((s, i) => ({ ...s, seq: i + 1 }))
}
