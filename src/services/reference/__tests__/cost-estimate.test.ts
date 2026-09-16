import { describe, it, expect } from 'vitest'
import { estimateReferenceCost, DIGEST_MAX_CHARS } from '../cost-estimate'

describe('estimateReferenceCost', () => {
  const chapters = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, wordCount: 3000 }))

  it('counts one call per chapter within range, plus fixed upper-layer calls', () => {
    const r = estimateReferenceCost(chapters, { from: 1, to: 200 })
    expect(r.digestCalls).toBe(200)
    expect(r.upperCalls).toBe(Math.ceil(200 / 100) + 2)
  })

  it('splits oversized chapters into two digest calls', () => {
    const big = [{ number: 1, wordCount: DIGEST_MAX_CHARS + 1 }]
    expect(estimateReferenceCost(big, { from: 1, to: 1 }).digestCalls).toBe(2)
  })

  it('clamps range to available chapters', () => {
    const r = estimateReferenceCost(chapters, { from: 900, to: 5000 })
    expect(r.digestCalls).toBe(101)
  })

  it('estimates minutes with concurrency 3 and 20s per call', () => {
    const r = estimateReferenceCost(chapters, { from: 1, to: 300 })
    expect(r.estimatedMinutes).toBe(Math.ceil(((300 / 3) * 20 + r.upperCalls * 40) / 60))
  })
})
