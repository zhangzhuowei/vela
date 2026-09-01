import { describe, it, expect } from 'vitest'
import { parseTextBlueprints, planDirectoryPrompt, chapterNumbersMissing, normalizeBlueprintRole } from '../directory-workflow'

const one = (n: number, title = `第${n}章`) =>
  `{"chapterNumber":${n},"title":"${title}","purpose":"p","characters":["林骁"],"keyEvents":"发生了什么","suspenseHook":"钩子"}`

describe('parseTextBlueprints', () => {
  it('keeps the wrapped blueprints object that the template asks for', () => {
    const raw = `{"blueprints":[${one(1, '第一弦')},${one(2)}]}`
    const got = parseTextBlueprints(raw, 1, 10)
    expect(got.map((b) => b.chapterNumber)).toEqual([1, 2])
    expect(got[0].title).toBe('第一弦')
  })

  it('accepts a root JSON array (current parser returns empty)', () => {
    const raw = `[${one(1, '第一弦')},${one(2)}]`
    const got = parseTextBlueprints(raw, 1, 10)
    expect(got.map((b) => b.chapterNumber)).toEqual([1, 2])
    expect(got[0].title).toBe('第一弦')
  })

  it('salvages complete chapters when the wrapper is truncated', () => {
    const raw = `{"blueprints":[${one(1, '第一弦')},${one(2)},{"chapterNumber":3,"title":"未写完","keyEvents":"截断`
    const got = parseTextBlueprints(raw, 1, 10)
    expect(got.map((b) => b.chapterNumber)).toEqual([1, 2])
  })

  it('keeps an explicit chapter role instead of the default', () => {
    const raw = `{"blueprints":[{"chapterNumber":1,"title":"开场","role":"建置","keyEvents":"e","characters":[]}]}`
    expect(parseTextBlueprints(raw, 1, 1)[0].role).toBe('建置')
  })

  it('normalizes english role aliases when parsing', () => {
    const raw = `{"blueprints":[{"chapterNumber":6,"title":"A","role":"climax","keyEvents":"e","characters":[]}]}`
    expect(parseTextBlueprints(raw, 1, 10)[0].role).toBe('高潮')
  })

  it('filters chapters outside the requested range', () => {
    const raw = `{"blueprints":[${one(1)},${one(8)},${one(20)}]}`
    expect(parseTextBlueprints(raw, 5, 10).map((b) => b.chapterNumber)).toEqual([8])
  })

  it('repairs bare newlines inside string values', () => {
    const NL = String.fromCharCode(10)
    const raw = `{"blueprints":[{"chapterNumber":1,"title":"A","keyEvents":"上一句${NL}下一句","characters":[]}]}`
    const got = parseTextBlueprints(raw, 1, 1)
    expect(got).toHaveLength(1)
    expect(got[0].keyEvents).toContain('上一句')
    expect(got[0].keyEvents).toContain('下一句')
  })
})

describe('planDirectoryPrompt', () => {
  it('does not ask the first full batch for the entire book', () => {
    const plan = planDirectoryPrompt({
      mode: 'full',
      cursor: 1,
      batchEnd: 49,
      endChapter: 150,
      totalChapters: 150,
    })
    expect(plan.templateKey).toBe('chapter_blueprint')
    expect(plan.numberOfChapters).toBe(49)
    expect(plan.from).toBe(1)
    expect(plan.to).toBe(49)
  })

  it('uses the chunk template after the first full batch', () => {
    const plan = planDirectoryPrompt({
      mode: 'full',
      cursor: 50,
      batchEnd: 98,
      endChapter: 150,
      totalChapters: 150,
    })
    expect(plan.templateKey).toBe('chapter_blueprint_chunk')
    expect(plan.numberOfChapters).toBe(150)
    expect(plan.from).toBe(50)
    expect(plan.to).toBe(98)
  })
})

describe('normalizeBlueprintRole', () => {
  it('maps aliases to the seven editor roles', () => {
    expect(normalizeBlueprintRole('建置')).toBe('建置')
    expect(normalizeBlueprintRole('setup')).toBe('建置')
    expect(normalizeBlueprintRole('Development')).toBe('发展')
    expect(normalizeBlueprintRole('climax')).toBe('高潮')
    expect(normalizeBlueprintRole('turning point')).toBe('转折')
    expect(normalizeBlueprintRole('')).toBe('')
  })
})

describe('chapterNumbersMissing', () => {
  it('returns chapter numbers that exist in the db list but not in the editor list', () => {
    expect(chapterNumbersMissing([1, 2, 3, 55], [1, 2, 3])).toEqual([55])
    expect(chapterNumbersMissing([1, 2, 5], [1, 2, 5])).toEqual([])
  })
})
