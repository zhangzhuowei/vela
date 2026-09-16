import { describe, it, expect } from 'vitest'
import {
  BRANCH_BASE, branchIdOf, localIndexOf, toChapterNumber, isMainChapter,
  visibilityFor, isVisible, isTimestampVisible, isPlotLineOpenAt, redactPlotLineForVisibility,
  previousChapterNumber, requiredPreviousChapter, isStoryOpening,
  displayChapterName, displayChapterNameSafe, chapterFileName, visibilityWhere,
  type BranchLike,
} from '../chapter-addressing'

const branches: BranchLike[] = [
  { id: 1, kind: 'extra', name: '温泉', anchorChapter: 120 },
  { id: 2, kind: 'if', name: '绫波线', anchorChapter: 80 },
  { id: 3, kind: 'extra', name: '前传', anchorChapter: 0 },
]

describe('addressing', () => {
  it('splits chapter number into branch id and local index', () => {
    expect(branchIdOf(57)).toBe(0)
    expect(branchIdOf(10003)).toBe(1)
    expect(localIndexOf(10003)).toBe(3)
    expect(toChapterNumber(2, 5)).toBe(20005)
    expect(isMainChapter(9999)).toBe(true)
    expect(isMainChapter(10000)).toBe(false)
  })
  it('rejects local index out of range', () => {
    expect(() => toChapterNumber(1, BRANCH_BASE)).toThrow()
    expect(() => toChapterNumber(1, 0)).toThrow()
  })
})

describe('visibilityFor', () => {
  it('main chapter sees main < n only', () => {
    expect(visibilityFor(57, branches)).toEqual({ mainUpTo: 56, branchId: 0, branchFrom: 0, branchUpTo: 0 })
  })
  it('branch chapter sees main <= anchor and own earlier chapters', () => {
    expect(visibilityFor(10003, branches)).toEqual({ mainUpTo: 120, branchId: 1, branchFrom: 10001, branchUpTo: 10002 })
  })
  it('first branch chapter has empty own range', () => {
    const v = visibilityFor(20001, branches)
    expect(v.branchFrom).toBe(20001)
    expect(v.branchUpTo).toBe(20000)
  })
  it('prequel with anchor 0 sees no main chapter', () => {
    expect(visibilityFor(30001, branches).mainUpTo).toBe(0)
  })
  it('throws for unknown branch', () => {
    expect(() => visibilityFor(90001, branches)).toThrow()
  })
})

describe('isVisible', () => {
  const v = visibilityFor(10003, branches)
  it.each([
    [1, true], [120, true], [121, false], [10001, true], [10002, true], [10003, false], [20001, false],
  ])('%i → %s', (n, expected) => {
    expect(isVisible(n, v)).toBe(expected)
  })
  it('compression summary (-1) is visible only to main', () => {
    expect(isVisible(-1, visibilityFor(57, branches))).toBe(true)
    expect(isVisible(-1, v)).toBe(false)
  })
})

describe('previousChapterNumber', () => {
  it('main n-1, null for chapter 1', () => {
    expect(previousChapterNumber(57, branches)).toBe(56)
    expect(previousChapterNumber(1, branches)).toBeNull()
  })
  it('first branch chapter continues from anchor; null when anchor is 0', () => {
    expect(previousChapterNumber(10001, branches)).toBe(120)
    expect(previousChapterNumber(30001, branches)).toBeNull()
  })
  it('later branch chapter continues from previous branch chapter', () => {
    expect(previousChapterNumber(10003, branches)).toBe(10002)
  })
})

describe('requiredPreviousChapter', () => {
  it('does not require chapter 10000 before the first extra', () => {
    expect(requiredPreviousChapter(10001, branches)).toBe(120)
    expect(requiredPreviousChapter(10001, branches)).not.toBe(10000)
  })
  it('prequel first chapter requires no predecessor', () => {
    expect(requiredPreviousChapter(30001, branches)).toBeNull()
  })
  it('unknown branch does not fall back to n-1', () => {
    expect(requiredPreviousChapter(90001, branches)).toBeNull()
  })
})

describe('isStoryOpening', () => {
  it('main chapter 1 is opening; chapter 2 is not', () => {
    expect(isStoryOpening(1, visibilityFor(1, []))).toBe(true)
    expect(isStoryOpening(2, visibilityFor(2, []))).toBe(false)
  })
  it('first extra after an anchor is not opening', () => {
    expect(isStoryOpening(10001, visibilityFor(10001, branches))).toBe(false)
  })
  it('prequel first chapter is opening', () => {
    expect(isStoryOpening(30001, visibilityFor(30001, branches))).toBe(true)
  })
})

describe('display and file names', () => {
  it('formats main / extra / if', () => {
    expect(displayChapterName(57, branches, '出港')).toBe('第57章 出港')
    expect(displayChapterName(10002, branches, '夜话')).toBe('番外·温泉 2 夜话')
    expect(displayChapterName(20003, branches, '')).toBe('IF·绫波线 第3章')
  })
  it('sanitizes file name', () => {
    expect(chapterFileName(10002, branches, 'a/b\\c')).toBe('番外·温泉 2 a_b_c.txt')
  })
  it('safe display does not throw for unknown branch', () => {
    expect(displayChapterNameSafe(90001, branches, 'x')).toBe('第90001章 x')
  })
  it('file name for unknown branch does not throw', () => {
    expect(chapterFileName(90001, branches, 'x')).toBe('第90001章 x.txt')
  })
})

describe('visibilityWhere', () => {
  it('builds a two-range predicate', () => {
    const w = visibilityWhere('chapter_number', visibilityFor(10003, branches))
    expect(w.sql).toBe('((chapter_number > 0 AND chapter_number <= ?) OR (chapter_number BETWEEN ? AND ?))')
    expect(w.params).toEqual([120, 10001, 10002])
  })
  it('main includes compression marker', () => {
    const w = visibilityWhere('chapter_number', visibilityFor(57, branches))
    expect(w.sql).toBe('(chapter_number <= ?)')
    expect(w.params).toEqual([56])
  })
  it('origin timestamps are visible on extras with an anchor, not on prequels', () => {
    const extra = visibilityWhere('started_at', visibilityFor(10001, branches), { origin: true })
    expect(extra.sql.startsWith('(started_at <= 0 OR ')).toBe(true)
    const prequel = visibilityWhere('started_at', visibilityFor(30001, branches), { origin: true })
    expect(prequel.sql.startsWith('(started_at <= 0 OR ')).toBe(false)
  })
})

describe('isTimestampVisible', () => {
  it('origin (0) is visible on main and on extras after an anchor, not on prequels', () => {
    expect(isTimestampVisible(0, visibilityFor(2, []))).toBe(true)
    expect(isTimestampVisible(0, visibilityFor(10001, branches))).toBe(true)
    expect(isTimestampVisible(0, visibilityFor(30001, branches))).toBe(false)
  })
})

describe('isPlotLineOpenAt', () => {
  const extra = visibilityFor(10001, branches) // main ≤ 120
  it('keeps a line that started before the extra and is still unresolved', () => {
    expect(isPlotLineOpenAt({ startedAt: 10 }, extra)).toBe(true)
    expect(isPlotLineOpenAt({ startedAt: 0 }, extra)).toBe(true)
  })
  it('hides a line resolved at or before the anchor', () => {
    expect(isPlotLineOpenAt({ startedAt: 10, resolvedAt: 80 }, extra)).toBe(false)
    expect(isPlotLineOpenAt({ startedAt: 10, resolvedAt: 120 }, extra)).toBe(false)
  })
  it('still treats a later-resolved line as open at the extra', () => {
    expect(isPlotLineOpenAt({ startedAt: 10, resolvedAt: 200 }, extra)).toBe(true)
  })
  it('hides lines that only start after the anchor', () => {
    expect(isPlotLineOpenAt({ startedAt: 150 }, extra)).toBe(false)
  })
  it('prequel sees no main-story plot lines', () => {
    const prequel = visibilityFor(30001, branches)
    expect(isPlotLineOpenAt({ startedAt: 0 }, prequel)).toBe(false)
    expect(isPlotLineOpenAt({ startedAt: 10 }, prequel)).toBe(false)
  })
  it('later extra chapter can see a line started on this extra', () => {
    const later = visibilityFor(10003, branches)
    expect(isPlotLineOpenAt({ startedAt: 10001 }, later)).toBe(true)
    expect(isPlotLineOpenAt({ startedAt: 10003 }, later)).toBe(false)
  })
})

describe('redactPlotLineForVisibility', () => {
  const extra = visibilityFor(10001, branches)
  it('clears currentState advanced after the anchor and presents later-resolved lines as active', () => {
    const redacted = redactPlotLineForVisibility({
      startedAt: 10,
      lastAdvancedAt: 180,
      resolvedAt: 200,
      currentState: '正史后期才发生的推进',
      status: 'resolved' as const,
    }, extra)
    expect(redacted.currentState).toBe('')
    expect(redacted.status).toBe('active')
    expect(redacted.lastAdvancedAt).toBe(10)
  })
  it('keeps currentState when last advance is visible', () => {
    const redacted = redactPlotLineForVisibility({
      startedAt: 10,
      lastAdvancedAt: 80,
      currentState: '锚点前的进度',
      status: 'active' as const,
    }, extra)
    expect(redacted.currentState).toBe('锚点前的进度')
    expect(redacted.lastAdvancedAt).toBe(80)
  })
})
