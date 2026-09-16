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
