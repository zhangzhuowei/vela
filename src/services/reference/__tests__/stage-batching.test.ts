import { describe, it, expect } from 'vitest'
import { batchByCount, mergeStageBatches, pickStageDraft, type StageDraft } from '../stage-batching'

const s = (from: number, to: number, title = ''): StageDraft => ({ title, fromChapter: from, toChapter: to, goal: '', antagonist: '', entryHook: '', exitPeak: '' })

describe('batchByCount', () => {
  it('splits into batches of given size keeping order', () => {
    const b = batchByCount([1, 2, 3, 4, 5], 2)
    expect(b).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('mergeStageBatches', () => {
  it('merges tail of batch A with head of batch B when B head continues A tail', () => {
    const merged = mergeStageBatches([
      [s(1, 40, '出岛'), s(41, 100, '港区初战')],
      [s(101, 120, '港区初战（续）'), s(121, 200, '北方远征')],
    ])
    expect(merged.map((x) => [x.fromChapter, x.toChapter])).toEqual([[1, 40], [41, 120], [121, 200]])
    expect(merged[1].title).toBe('港区初战')
  })

  it('does not merge when head is a genuinely new stage', () => {
    const merged = mergeStageBatches([[s(1, 100, 'A')], [s(101, 200, 'B')]])
    expect(merged).toHaveLength(2)
  })

  it('renumbers seq from 1', () => {
    const merged = mergeStageBatches([[s(1, 50, 'A'), s(51, 100, 'B')]])
    expect(merged.map((x) => x.seq)).toEqual([1, 2])
  })
})

describe('pickStageDraft', () => {
  it('returns null when empty', () => {
    expect(pickStageDraft([], 1, 10)).toBeNull()
  })

  it('prefers an exact from-to match', () => {
    const drafts = [s(1, 8, 'A'), s(9, 20, 'B')]
    expect(pickStageDraft(drafts, 9, 20)?.title).toBe('B')
  })

  it('falls back to the largest overlap, then the first draft', () => {
    expect(pickStageDraft([s(1, 5, 'A'), s(6, 20, 'B')], 8, 12)?.title).toBe('B')
    expect(pickStageDraft([s(30, 40, 'C')], 1, 10)?.title).toBe('C')
  })
})
