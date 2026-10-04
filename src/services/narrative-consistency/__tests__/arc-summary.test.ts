import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARC_SIZE, arcRangeOf, isArcEnd, formatChapterSummariesForArc, formatArcSummariesForBook, selectLongTermSummary,
} from '../arc-summary'
import { renderCanonContext } from '../context-builder'
import type { ArcSummary } from '../types'
import { makeCanon } from './fixtures'
import { initProjectDatabase, closeProjectDatabase } from '../../../../electron/database'
import { CanonRepository } from '../../../../electron/repositories/canon-repository'

function arc(start: number, end: number, summary = `第${start}-${end}章剧情`): ArcSummary {
  return { level: 'arc', startChapter: start, endChapter: end, title: '', summary, createdAt: '' }
}

function book(end: number, summary = `全书至第${end}章`): ArcSummary {
  return { level: 'book', startChapter: 1, endChapter: end, title: '', summary, createdAt: '' }
}

describe('分层摘要：卷的划分', () => {
  it('每卷固定 ARC_SIZE 章，按章节号计算所在卷', () => {
    expect(ARC_SIZE).toBe(10)
    expect(arcRangeOf(1)).toEqual([1, 10])
    expect(arcRangeOf(10)).toEqual([1, 10])
    expect(arcRangeOf(11)).toEqual([11, 20])
    expect(arcRangeOf(0)).toEqual([1, 10])
    expect(isArcEnd(10)).toBe(true)
    expect(isArcEnd(20)).toBe(true)
    expect(isArcEnd(15)).toBe(false)
    expect(isArcEnd(0)).toBe(false)
  })

  it('生成输入：章节要点按章排序、跳过空要点并截断；卷摘要按起始章排序', () => {
    const text = formatChapterSummariesForArc([
      { chapterNumber: 3, title: '夜袭', summary: 'x'.repeat(700), createdAt: '' },
      { chapterNumber: 1, title: '', summary: '开篇', createdAt: '' },
      { chapterNumber: 2, title: '空', summary: '  ', createdAt: '' },
    ])
    expect(text.indexOf('【第1章】')).toBeLessThan(text.indexOf('【第3章 夜袭】'))
    expect(text).not.toContain('第2章')
    expect(text).toContain('…')

    const bookInput = formatArcSummariesForBook([arc(11, 20), book(20), arc(1, 10)])
    expect(bookInput.indexOf('【第1-10章】')).toBeLessThan(bookInput.indexOf('【第11-20章】'))
    expect(bookInput).not.toContain('全书至')
  })
})

describe('分层摘要：写作时的远期记忆', () => {
  it('没有分层摘要时为空', () => {
    expect(selectLongTermSummary([], 30)).toBe('')
  })

  it('只用完全位于本章之前的卷；重写早期章节时不泄露后文', () => {
    const all = [arc(1, 10), arc(11, 20), arc(21, 30), book(30)]
    const forCh15 = selectLongTermSummary(all, 15)
    expect(forCh15).toContain('第1-10章剧情')
    expect(forCh15).not.toContain('第11-20章剧情')
    expect(forCh15).not.toContain('全书至')
  })

  it('有全书摘要时：全书摘要 + 最近两卷 + 全书摘要尚未覆盖的卷', () => {
    const arcs = [arc(1, 10), arc(11, 20), arc(21, 30), arc(31, 40), arc(41, 50)]
    const fresh = selectLongTermSummary([...arcs, book(50)], 51)
    expect(fresh).toContain('全书至第50章')
    expect(fresh).toContain('第31-40章剧情')
    expect(fresh).toContain('第41-50章剧情')
    expect(fresh).not.toContain('第21-30章剧情')

    // 全书摘要停在第 20 章（后面几次生成失败）：之后的各卷都要带上
    const stale = selectLongTermSummary([...arcs, book(20)], 51)
    expect(stale).toContain('全书至第20章')
    for (const range of ['21-30', '31-40', '41-50']) expect(stale).toContain(`第${range}章剧情`)
  })

  it('摘要里的 {{xxx}} 会被转义，不会被 prompt-builder 当成占位符', () => {
    const text = selectLongTermSummary([arc(1, 10, '他念出 {{chapter_title}}')], 11)
    expect(text).not.toContain('{{')
    expect(text).toContain('⦃⦃chapter_title⦄⦄')
  })

  it('渲染 Canon Context 时放在「最近章节摘要」之前；为空时整段省略', () => {
    const withLongTerm = renderCanonContext({ ...makeCanon(), longTermSummary: '《卷摘要（第1-10章）》\n主角拜师' })
    const idx = withLongTerm.indexOf('【前情提要')
    expect(idx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(withLongTerm.indexOf('【最近章节摘要】'))
    expect(renderCanonContext(makeCanon())).not.toContain('【前情提要')
  })
})

describe('分层摘要：SQLite 持久化', () => {
  it('卷 / 全书摘要可写入与覆盖；章节摘要按范围读取；旧版 -1 压缩行不再混进最近章节摘要', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'vela-arc-'))
    try {
      initProjectDatabase(projectDir)
      for (const n of [1, 2, 3, 11]) {
        CanonRepository.upsertSummary({ chapterNumber: n, title: `第${n}章`, summary: `摘要${n}`, createdAt: '' })
      }
      CanonRepository.upsertSummary({ chapterNumber: -1, title: '压缩摘要', summary: '旧版压缩', createdAt: '' })

      expect(CanonRepository.getSummariesInRange(1, 10).map((s) => s.chapterNumber)).toEqual([1, 2, 3])
      expect(CanonRepository.getRecentSummaries(10).map((s) => s.chapterNumber)).toEqual([1, 2, 3, 11])

      CanonRepository.upsertArcSummary({ ...arc(11, 20), summary: '第二卷' })
      CanonRepository.upsertArcSummary({ ...arc(1, 10), summary: '第一卷（旧）' })
      CanonRepository.upsertArcSummary({ ...arc(1, 10), summary: '第一卷（重写后）' })
      CanonRepository.upsertArcSummary(book(20))

      const all = CanonRepository.listArcSummaries()
      expect(all.map((a) => `${a.level}:${a.startChapter}-${a.endChapter}`)).toEqual(['arc:1-10', 'arc:11-20', 'book:1-20'])
      expect(all[0].summary).toBe('第一卷（重写后）')
    } finally {
      closeProjectDatabase()
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
