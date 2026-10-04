import { describe, it, expect } from 'vitest'
import { groupTimeline, findBookSummary, matchesTimelineFilter, parseKeywords } from '../timeline-view'
import type { CanonArcSummary, CanonTimelineEvent } from '../../shared/ipc-channels'

function ev(chapterNumber: number, sequence: number, patch: Partial<CanonTimelineEvent> = {}): CanonTimelineEvent {
  return {
    id: chapterNumber * 100 + sequence,
    chapterNumber,
    sequence,
    characters: [],
    location: '',
    timeFlow: 'sequential',
    summary: `第${chapterNumber}章事件${sequence}`,
    impact: '',
    ...patch,
  }
}

function arc(startChapter: number, endChapter: number, summary: string, level: CanonArcSummary['level'] = 'arc'): CanonArcSummary {
  return { level, startChapter, endChapter, title: `标题${startChapter}`, summary, createdAt: '' }
}

const all = { keyword: '', includeFlashback: true }

describe('groupTimeline', () => {
  it('按卷、章分组：卷与章升序，章内按 sequence 排序，挂上对应卷摘要', () => {
    const events = [ev(12, 2), ev(3, 1), ev(12, 1), ev(3, 2), ev(1, 1)]
    const groups = groupTimeline(events, [arc(11, 20, '第二卷发生的事'), arc(1, 10, '第一卷发生的事')], all)

    expect(groups.map(g => [g.startChapter, g.endChapter, g.eventCount])).toEqual([[1, 10, 3], [11, 20, 2]])
    expect(groups[0].chapters.map(c => c.chapterNumber)).toEqual([1, 3])
    expect(groups[1].chapters[0].events.map(e => e.sequence)).toEqual([1, 2])
    expect(groups.map(g => g.summary?.summary)).toEqual(['第一卷发生的事', '第二卷发生的事'])
  })

  it('不筛选时列出只有卷摘要的卷；与卷划分对不上的旧摘要、空摘要不挂', () => {
    const groups = groupTimeline(
      [ev(25, 1)],
      [arc(1, 10, '只有摘要'), arc(5, 14, '划分对不上'), arc(11, 20, '   ')],
      all,
    )
    expect(groups.map(g => [g.startChapter, g.chapters.length, g.summary?.summary])).toEqual([
      [1, 0, '只有摘要'],
      [21, 1, undefined],
    ])
  })

  it('筛选：关键词须全部命中（人物、地点、影响也算，不区分大小写），闪回可排除，无匹配的卷不列出', () => {
    const events = [
      ev(1, 1, { characters: ['林风', 'Alice'], location: '青云山', summary: '初入山门' }),
      ev(2, 1, { characters: ['林风'], location: '山下小镇', impact: '结识苏晴' }),
      ev(15, 1, { characters: ['林风'], timeFlow: 'flashback', summary: '回忆童年' }),
      ev(16, 1, { characters: ['Мария'], summary: 'Встреча' }),
    ]
    const summaries = [arc(1, 10, '第一卷'), arc(11, 20, '第二卷')]

    const byTwo = groupTimeline(events, summaries, { keyword: '林风  青云山', includeFlashback: true })
    expect(byTwo.flatMap(g => g.chapters.map(c => c.chapterNumber))).toEqual([1])

    expect(groupTimeline(events, summaries, { keyword: 'alice', includeFlashback: true })
      .flatMap(g => g.chapters.map(c => c.chapterNumber))).toEqual([1])
    expect(groupTimeline(events, summaries, { keyword: 'мария', includeFlashback: true })
      .flatMap(g => g.chapters.map(c => c.chapterNumber))).toEqual([16])
    expect(groupTimeline(events, summaries, { keyword: '苏晴', includeFlashback: true })
      .flatMap(g => g.chapters.map(c => c.chapterNumber))).toEqual([2])

    const noFlashback = groupTimeline(events, summaries, { keyword: '林风', includeFlashback: false })
    expect(noFlashback.map(g => g.startChapter)).toEqual([1])
    expect(noFlashback[0].summary?.summary).toBe('第一卷')

    expect(groupTimeline(events, summaries, { keyword: '不存在', includeFlashback: true })).toEqual([])
  })
})

describe('辅助函数', () => {
  it('parseKeywords 按空白拆分并转小写', () => {
    expect(parseKeywords('  Lin  FENG\t青云 ')).toEqual(['lin', 'feng', '青云'])
    expect(parseKeywords('   ')).toEqual([])
  })

  it('matchesTimelineFilter 不筛选时全部通过', () => {
    expect(matchesTimelineFilter(ev(1, 1, { timeFlow: 'flashback' }), all)).toBe(true)
  })

  it('findBookSummary 只认非空的全书摘要', () => {
    expect(findBookSummary([arc(1, 10, '卷')])).toBeUndefined()
    expect(findBookSummary([arc(1, 30, '  ', 'book')])).toBeUndefined()
    expect(findBookSummary([arc(1, 10, '卷'), arc(1, 30, '全书', 'book')])?.summary).toBe('全书')
  })
})
