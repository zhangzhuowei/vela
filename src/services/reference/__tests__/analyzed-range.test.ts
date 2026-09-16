import { describe, it, expect } from 'vitest'
import { chapterRunQueue, contiguousAnalyzedTo, nextDigestRange } from '../analyzed-range'

describe('contiguousAnalyzedTo', () => {
  it('returns 0 when nothing succeeded', () => {
    expect(contiguousAnalyzedTo([])).toBe(0)
    expect(contiguousAnalyzedTo([2, 3])).toBe(0)
  })

  it('returns the last chapter of a prefix from 1', () => {
    expect(contiguousAnalyzedTo([1, 2, 3, 4])).toBe(4)
  })

  it('stops before the first hole (cancel / concurrent skip)', () => {
    expect(contiguousAnalyzedTo([1, 2, 3, 5, 6])).toBe(3)
  })

  it('ignores order and duplicates', () => {
    expect(contiguousAnalyzedTo([3, 1, 1, 2])).toBe(3)
  })
})

describe('nextDigestRange', () => {
  it('starts at the first pending chapter, not analyzedTo+1', () => {
    expect(nextDigestRange([50, 51, 200], 300, 200)).toEqual({ from: 50, to: 249 })
  })

  it('clamps to total chapters', () => {
    expect(nextDigestRange([190], 200, 200)).toEqual({ from: 190, to: 200 })
  })

  it('returns null when there is nothing left', () => {
    expect(nextDigestRange([], 200, 200)).toBeNull()
  })
})

describe('chapterRunQueue', () => {
  it('uses pending when force is empty or omitted', () => {
    expect(chapterRunQueue([3, 4])).toEqual([3, 4])
    expect(chapterRunQueue([3, 4], [])).toEqual([3, 4])
  })

  it('reruns forced chapters even if they are not pending', () => {
    expect(chapterRunQueue([5], [1, 2, 1])).toEqual([1, 2])
  })
})
