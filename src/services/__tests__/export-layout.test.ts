import { describe, expect, it } from 'vitest'
import { layoutExportDocuments, type LayoutBranch, type LayoutChapter } from '../export-layout'

const branches: LayoutBranch[] = [
  { id: 1, kind: 'extra', name: '温泉', anchorChapter: 2, sortOrder: 0 },
  { id: 2, kind: 'if', name: '绫波线', anchorChapter: 1, sortOrder: 1 },
  { id: 3, kind: 'extra', name: '前传', anchorChapter: 0, sortOrder: 2 },
]

const chapters: LayoutChapter[] = [
  { chapterNumber: 1, title: '起', content: 'c1' },
  { chapterNumber: 2, title: '承', content: 'c2' },
  { chapterNumber: 3, title: '转', content: 'c3' },
  { chapterNumber: 10001, title: '夜话', content: 'e1' },
  { chapterNumber: 20001, title: 'IF1', content: 'i1' },
  { chapterNumber: 30001, title: '幼年', content: 'p1' },
]

describe('layoutExportDocuments', () => {
  it('appendix: main file ends with extras section; IF is a separate file', () => {
    const docs = layoutExportDocuments('测试书', chapters, branches, 'appendix', true)
    expect(docs.map((d) => d.fileStem)).toEqual(['测试书', '测试书·IF·绫波线'])
    expect(docs[0].chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 30001, 10001])
    expect(docs[0].chapters[3].section).toBe('番外')
    expect(docs[0].chapters[3].title).toBe('番外·前传 1 幼年')
    expect(docs[0].chapters[4].title).toBe('番外·温泉 1 夜话')
    expect(docs[1].chapters[0].title).toBe('IF·绫波线 第1章 IF1')
  })

  it('separate: main + each extra + each IF', () => {
    const docs = layoutExportDocuments('测试书', chapters, branches, 'separate', true)
    expect(docs.map((d) => d.fileStem)).toEqual([
      '测试书',
      '测试书·番外·温泉',
      '测试书·番外·前传',
      '测试书·IF·绫波线',
    ])
    expect(docs[0].chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 3])
  })

  it('inline: extras with anchor 0 go first; others after their anchor chapter', () => {
    const docs = layoutExportDocuments('测试书', chapters, branches, 'inline', true)
    expect(docs[0].chapters.map((c) => c.chapterNumber)).toEqual([30001, 1, 2, 10001, 3])
    expect(docs.map((d) => d.fileStem)).toEqual(['测试书', '测试书·IF·绫波线'])
  })

  it('includeIf=false skips IF documents', () => {
    const docs = layoutExportDocuments('测试书', chapters, branches, 'appendix', false)
    expect(docs.map((d) => d.fileStem)).toEqual(['测试书'])
  })

  it('same-anchor extras follow sortOrder then chapter number', () => {
    const extraBranches: LayoutBranch[] = [
      { id: 1, kind: 'extra', name: '后', anchorChapter: 1, sortOrder: 2 },
      { id: 4, kind: 'extra', name: '先', anchorChapter: 1, sortOrder: 1 },
    ]
    const extraChapters: LayoutChapter[] = [
      { chapterNumber: 1, title: '正', content: 'm' },
      { chapterNumber: 10001, title: 'B', content: 'b' },
      { chapterNumber: 40001, title: 'A', content: 'a' },
    ]
    const docs = layoutExportDocuments('书', extraChapters, extraBranches, 'inline', false)
    expect(docs[0].chapters.map((c) => c.chapterNumber)).toEqual([1, 40001, 10001])
  })

  it('emits no empty documents when a line has no chapters', () => {
    const docs = layoutExportDocuments('书', [{ chapterNumber: 1, title: '一', content: 'x' }], branches, 'separate', true)
    expect(docs.map((d) => d.fileStem)).toEqual(['书'])
  })

  it('does not throw when a chapter belongs to an unknown branch', () => {
    const orphan = [...chapters, { chapterNumber: 90001, title: '孤', content: 'x' }]
    expect(() => layoutExportDocuments('测试书', orphan, branches, 'appendix', true)).not.toThrow()
  })

  it('unknown-branch chapters go to a leftover document', () => {
    const orphan = [...chapters, { chapterNumber: 90002, title: '乙', content: 'b' }, { chapterNumber: 90001, title: '甲', content: 'a' }]
    const docs = layoutExportDocuments('测试书', orphan, branches, 'appendix', true)
    expect(docs.map((d) => d.fileStem)).toContain('测试书·未登记线')
    const leftover = docs.find((d) => d.fileStem.endsWith('未登记线'))
    expect(leftover?.chapters.map((c) => c.chapterNumber)).toEqual([90001, 90002])
    expect(leftover?.chapters[0].section).toBe('未登记线')
  })

  it('skipped IF chapters are not treated as leftovers', () => {
    const docs = layoutExportDocuments('测试书', chapters, branches, 'appendix', false)
    expect(docs.map((d) => d.fileStem)).toEqual(['测试书'])
    expect(docs[0].chapters.some((c) => c.chapterNumber === 20001)).toBe(false)
  })
})
