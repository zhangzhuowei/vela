import { describe, it, expect } from 'vitest'
import { batchByCount, mergeStageBatches, pickStageDraft, excludeLockedRanges, type StageDraft } from '../stage-batching'

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

describe('excludeLockedRanges', () => {
  const locked = [{ fromChapter: 40, toChapter: 50 }]

  it('returns drafts untouched when nothing is locked or nothing overlaps', () => {
    expect(excludeLockedRanges([s(1, 10, 'A')], [])).toEqual([s(1, 10, 'A')])
    expect(excludeLockedRanges([s(1, 39, 'A'), s(51, 60, 'B')], locked).map((x) => [x.fromChapter, x.toChapter]))
      .toEqual([[1, 39], [51, 60]])
  })

  it('drops a draft fully inside a locked range', () => {
    expect(excludeLockedRanges([s(42, 48, 'inside')], locked)).toEqual([])
  })

  it('clips a draft that overlaps one side of a locked range', () => {
    expect(excludeLockedRanges([s(30, 45, 'left')], locked).map((x) => [x.fromChapter, x.toChapter])).toEqual([[30, 39]])
    expect(excludeLockedRanges([s(45, 60, 'right')], locked).map((x) => [x.fromChapter, x.toChapter])).toEqual([[51, 60]])
  })

  it('splits a draft that spans across a locked range and keeps output sorted', () => {
    const out = excludeLockedRanges([s(30, 60, 'span')], locked)
    expect(out.map((x) => [x.fromChapter, x.toChapter, x.title])).toEqual([[30, 39, 'span'], [51, 60, 'span']])
  })

  it('handles several locked ranges', () => {
    const out = excludeLockedRanges([s(1, 100, 'all')], [{ fromChapter: 10, toChapter: 20 }, { fromChapter: 60, toChapter: 70 }])
    expect(out.map((x) => [x.fromChapter, x.toChapter])).toEqual([[1, 9], [21, 59], [71, 100]])
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
