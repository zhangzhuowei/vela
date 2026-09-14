import { describe, expect, it } from 'vitest'
import { allocateKbHits, isBlockedKbImportName, kbKindOf, kbOverfetch, kbQuota, normalizeKbChunks, wordlistUsageNote } from '../kb-allocate'

const hit = (fileName: string, score: number) => ({ fileName, text: fileName, score })

describe('isBlockedKbImportName', () => {
  it('blocks worksheet files marked 不导入', () => {
    expect(isBlockedKbImportName('设定决策表·待填（不导入）.md')).toBe(true)
    expect(isBlockedKbImportName('C:\\\\Downloads\\\\场面规划清单·不导入.md')).toBe(true)
    expect(isBlockedKbImportName('词表·情色描写用词.md')).toBe(false)
  })
})

describe('normalizeKbChunks', () => {
  it('sorts by chunkIndex', () => {
    const out = normalizeKbChunks([
      { id: 'b', chunkIndex: 1, text: 'second', fileName: 'a.md' },
      { id: 'a', chunkIndex: 0, text: 'first', fileName: 'a.md' },
    ])
    expect(out.map((c) => c.text)).toEqual(['first', 'second'])
  })
})

describe('kbKindOf', () => {
  it('classifies by file name prefix', () => {
    expect(kbKindOf('设定·婚姻制度.md')).toBe('setting')
    expect(kbKindOf('词表·情色描写用词.md')).toBe('wordlist')
    expect(kbKindOf('写法示例·性癖与场面.md')).toBe('wordlist')
    expect(kbKindOf('姿势详解·一男一女.md')).toBe('wordlist')
    expect(kbKindOf('第3章 被白浊污染.txt')).toBe('other')
  })
})

describe('allocateKbHits', () => {
  it('returns everything untouched when under topK', () => {
    const hits = [hit('词表·a.md', 0.9), hit('设定·b.md', 0.8)]
    expect(allocateKbHits(hits, 5)).toEqual(hits)
  })

  it('caps wordlist at its quota so settings and prose survive', () => {
    const hits = [
      hit('词表·1.md', 0.99),
      hit('词表·2.md', 0.98),
      hit('词表·3.md', 0.97),
      hit('词表·4.md', 0.96),
      hit('词表·5.md', 0.95),
      hit('设定·婚姻制度.md', 0.5),
      hit('第2章.txt', 0.4),
      hit('第1章.txt', 0.3),
    ]
    // 保底：设定 2（只有 1 个）、词表 1、其余 2 → 词表1、设定、第2章、第1章；剩 1 位按排名补 → 词表2
    const out = allocateKbHits(hits, 5).map((h) => h.fileName)
    expect(out).toEqual(['词表·1.md', '词表·2.md', '设定·婚姻制度.md', '第2章.txt', '第1章.txt'])
  })

  it('backfills unused quota by original rank', () => {
    const hits = [hit('第1章.txt', 0.9), hit('第2章.txt', 0.8), hit('第3章.txt', 0.7), hit('第4章.txt', 0.6), hit('第5章.txt', 0.5), hit('第6章.txt', 0.4)]
    expect(allocateKbHits(hits, 5).map((h) => h.fileName)).toEqual(['第1章.txt', '第2章.txt', '第3章.txt', '第4章.txt', '第5章.txt'])
  })

  it('keeps original ranking order in the output', () => {
    const hits = [hit('词表·1.md', 0.9), hit('词表·2.md', 0.8), hit('设定·x.md', 0.7), hit('第1章.txt', 0.6)]
    expect(allocateKbHits(hits, 3).map((h) => h.fileName)).toEqual(['词表·1.md', '设定·x.md', '第1章.txt'])
  })
})

describe('quota helpers', () => {
  it('scales quota with topK and overfetches x3 capped at 15', () => {
    expect(kbQuota(5)).toEqual({ setting: 2, wordlist: 1, other: 2 })
    expect(kbQuota(4)).toEqual({ setting: 1, wordlist: 1, other: 2 })
    expect(kbOverfetch(5)).toBe(15)
    expect(kbOverfetch(4)).toBe(12)
    expect(kbOverfetch(10)).toBe(15)
  })

  it('emits the usage note only when a wordlist hit is present', () => {
    expect(wordlistUsageNote([hit('第1章.txt', 1)])).toBe('')
    expect(wordlistUsageNote([hit('词表·a.md', 1)])).toContain('不得照抄整行')
  })
})
