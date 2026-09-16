import { describe, it, expect } from 'vitest'
import { normalizeName, buildLineMatrix, computeLineStats, suggestLineCandidates } from '../line-matrix'
import type { RefDigestData, RefLineData } from '../../../../electron/repositories/reference-repository'

const line = (id: number, name: string, aliases: string[] = []): RefLineData =>
  ({ id, workId: 1, name, aliases, kind: 'romance', sortOrder: id, locked: false, arcSummary: '' })

const digest = (n: number, states: Array<[string, RefDigestData['characterStates'][0]['stage'], RefDigestData['characterStates'][0]['func']]>, active = '', intimate = false): RefDigestData => ({
  workId: 1, chapterNumber: n, summary: '', events: [], hook: '', activeLine: active,
  characterStates: states.map(([name, stage, func]) => ({ name, stage, func })),
  introduced: [], intimate, status: 'ok', error: '', updatedAt: '',
})

const lines = [line(1, '绫波', ['小绫']), line(2, '爱宕')]

describe('normalizeName', () => {
  it('maps alias to canonical line id', () => {
    expect(normalizeName('小绫', lines)).toBe(1)
    expect(normalizeName('爱宕', lines)).toBe(2)
    expect(normalizeName('路人', lines)).toBeNull()
  })
})

describe('buildLineMatrix', () => {
  it('produces one row per line and one cell per chapter', () => {
    const m = buildLineMatrix([
      digest(1, [['绫波', 'first_meet', 'main']], '绫波'),
      digest(2, [['小绫', 'progress', 'main'], ['爱宕', 'first_meet', 'introduce']], '绫波'),
      digest(3, [['爱宕', 'progress', 'main'], ['绫波', 'done', 'daily']], '爱宕'),
    ], lines)
    expect(m.chapters).toEqual([1, 2, 3])
    expect(m.rows.map((r) => r.lineId)).toEqual([1, 2])
    expect(m.rows[0].cells.map((c) => c?.func ?? null)).toEqual(['main', 'main', 'daily'])
    expect(m.rows[1].cells.map((c) => c?.func ?? null)).toEqual([null, 'introduce', 'main'])
  })

  it('skips failed digests', () => {
    const bad = { ...digest(2, [['绫波', 'progress', 'main']]), status: 'failed' as const }
    const m = buildLineMatrix([digest(1, [['绫波', 'first_meet', 'main']]), bad], lines)
    expect(m.chapters).toEqual([1])
  })
})

describe('computeLineStats', () => {
  const m = buildLineMatrix([
    digest(1, [['绫波', 'first_meet', 'main']], '绫波'),
    digest(2, [['绫波', 'progress', 'main']], '绫波', true),
    digest(3, [['绫波', 'closure', 'main'], ['爱宕', 'first_meet', 'introduce']], '绫波'),
    digest(4, [['爱宕', 'progress', 'main'], ['绫波', 'done', 'assist']], '爱宕'),
    digest(5, [['爱宕', 'progress', 'main']], '爱宕'),
    digest(8, [['爱宕', 'breakthrough', 'main'], ['绫波', 'done', 'daily']], '爱宕', true),
  ], lines)
  const stats = computeLineStats(m)

  it('finds first/last main chapters and counts per func', () => {
    const a = stats.perLine.find((s) => s.lineId === 1)!
    expect(a.firstChapter).toBe(1)
    expect(a.lastMainChapter).toBe(3)
    expect(a.mainCount).toBe(3)
    expect(a.assistCount).toBe(1)
    expect(a.dailyCount).toBe(1)
    expect(a.introduceCount).toBe(0)
    expect(a.intimateCount).toBe(1)
  })

  it('computes longest absence gap in chapters', () => {
    const a = stats.perLine.find((s) => s.lineId === 1)!
    expect(a.maxGap).toBe(4) // 第 4 章 → 第 8 章
  })

  it('records switch points of the active line', () => {
    expect(stats.switchPoints).toEqual([{ chapter: 4, fromLineId: 1, toLineId: 2 }])
  })

  it('computes average main-line run length', () => {
    expect(stats.avgMainRun).toBe(3) // 绫波 3 章，爱宕 3 章（4,5,8）
  })
})

describe('suggestLineCandidates', () => {
  it('ranks names by main/introduce weight and reports first chapter', () => {
    const c = suggestLineCandidates([
      digest(1, [['绫波', 'first_meet', 'main'], ['指挥官', 'none', 'mention']]),
      digest(2, [['绫波', 'progress', 'main'], ['爱宕', 'first_meet', 'introduce']]),
      digest(3, [['爱宕', 'progress', 'main']]),
    ])
    expect(c[0].name).toBe('绫波')
    expect(c[0].firstChapter).toBe(1)
    expect(c.find((x) => x.name === '爱宕')!.mainCount).toBe(1)
    expect(c.find((x) => x.name === '指挥官')!.score).toBeLessThan(c[1].score)
  })
})
