import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initProjectDatabase, closeProjectDatabase } from '../database'
import { DraftRepository } from '../repositories/draft-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import {
  ChapterSearchRepository, CHAPTER_SEARCH_LIMITS, makeSnippet,
} from '../repositories/chapter-search-repository'
import { ValidationError, validateChapterSearchArgs, MAX_SEARCH_QUERY_LEN } from '../ipc-validation'

/**
 * 全局搜索（db:search-chapters）：代表稿选择、字面量匹配、偏移与片段、条数上限、入参校验。
 * 依赖 better-sqlite3 原生模块（本机需用 Electron 运行 vitest，见 steering dev-environment §13）。
 */

function blueprint(chapterNumber: number, title: string) {
  return {
    chapterNumber, title, role: '', purpose: '', keyEvents: '', characters: [],
    suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '',
  }
}

function addDraft(chapterNumber: number, version: number, content: string, status?: string): number {
  const id = DraftRepository.create({ chapterNumber, version, source: 'write', content, wordCount: content.length })
  if (status) DraftRepository.updateStatus(id, status)
  return id
}

const search = ChapterSearchRepository.search

describe('全局搜索：各章代表稿', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-search-'))
    initProjectDatabase(projectDir)
  })

  afterEach(() => {
    closeProjectDatabase()
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('每章只搜一份：定稿优先于更新的草稿，归档稿不参与，没有定稿时搜最新草稿', () => {
    const ch1Final = addDraft(1, 1, '林风推开了山门。', 'finalized')
    addDraft(1, 2, '林风推开了山门，林风又关上。') // 更新但未定稿：不搜
    const ch2Latest = addDraft(2, 2, '林风下山。', 'revised')
    addDraft(2, 1, '林风下山，旧版。')
    addDraft(2, 3, '林风下山（已废弃）', 'archived')
    addDraft(3, 1, '林风归来。', 'archived') // 只有归档稿：整章不参与
    BlueprintRepository.upsert(blueprint(1, '山门'))

    const res = search('林风')
    expect(res.chapters.map(c => [c.chapterNumber, c.draftId, c.version, c.status])).toEqual([
      [1, ch1Final, 1, 'finalized'],
      [2, ch2Latest, 2, 'revised'],
    ])
    expect(res.chapters.map(c => c.title)).toEqual(['山门', ''])
    expect(res.totalMatches).toBe(2)
    expect(res.truncated).toBe(false)
    expect(res.countCapped).toBe(false)

    expect(search('林风', { finalizedOnly: true }).chapters.map(c => c.chapterNumber)).toEqual([1])
  })

  it('按字面量匹配：正则元字符不生效；默认不区分大小写（含西里尔字母），可切换为区分', () => {
    addDraft(1, 1, 'Alice met ALICE. Цена (1+1) = 2? Привет, ПРИВЕТ.')

    expect(search('alice').totalMatches).toBe(2)
    expect(search('alice', { caseSensitive: true }).totalMatches).toBe(0)
    expect(search('Alice', { caseSensitive: true }).totalMatches).toBe(1)
    expect(search('привет').totalMatches).toBe(2)
    expect(search('(1+1)').totalMatches).toBe(1)
    expect(search('.').totalMatches).toBe(2)
    expect(search('?').totalMatches).toBe(1)
    // 命中文本保留原文大小写
    expect(search('alice').chapters[0].hits.map(h => h.match)).toEqual(['Alice', 'ALICE'])
    // 空白查询不搜
    expect(search('   ')).toEqual({ chapters: [], totalMatches: 0, truncated: false, countCapped: false })
  })

  it('偏移按统一为 \\n 后的正文计算（与编辑器坐标一致），片段不跨段、过长处截断', () => {
    const tail = '很长'.repeat(30)
    const body = `第一段没有关键词。\r\n\r\n\u3000\u3000第二段开头，然后出现了青铜剑，后面还有${tail}的叙述。\r\n第三段`
    addDraft(1, 1, body)
    const normalized = body.replace(/\r\n/g, '\n')

    const [hit] = search('青铜剑').chapters[0].hits
    expect(normalized.slice(hit.offset, hit.offset + hit.length)).toBe('青铜剑')
    // 前文 12 字以内并去掉段首缩进；截断时以 … 开头
    expect(hit.before).toBe('…第二段开头，然后出现了')
    // 后文 40 字以内、不跨到下一段；截断时以 … 结尾
    expect(hit.after.endsWith('…')).toBe(true)
    expect(hit.after.length).toBeLessThanOrEqual(CHAPTER_SEARCH_LIMITS.contextAfter + 1)
    expect(hit.after).not.toContain('第三段')

    const [last] = search('第三段').chapters[0].hits
    expect(normalized.slice(last.offset, last.offset + last.length)).toBe('第三段')
    expect([last.before, last.after]).toEqual(['', ''])

    const [first] = search('第一段').chapters[0].hits
    expect(first.offset).toBe(0)
    expect(first.before).toBe('')
    expect(first.after).toBe('没有关键词。')
  })

  it('条数上限：每章与总计限制明细，但每个命中章节至少保留一条；计数达上限即停止扫描', () => {
    for (let n = 1; n <= 5; n++) addDraft(n, 1, '剑'.repeat(10))
    const limits = { ...CHAPTER_SEARCH_LIMITS, hitsPerChapter: 3, hitsTotal: 5 }

    const res = search('剑', {}, limits)
    expect(res.chapters.map(c => c.hits.length)).toEqual([3, 2, 1, 1, 1])
    expect(res.chapters.map(c => c.matchCount)).toEqual([10, 10, 10, 10, 10])
    expect(res.totalMatches).toBe(50)
    expect(res.truncated).toBe(true)
    expect(res.countCapped).toBe(false)

    const capped = search('剑', {}, { ...limits, maxCount: 25 })
    expect(capped.chapters.map(c => c.matchCount)).toEqual([10, 10, 5])
    expect(capped.totalMatches).toBe(25)
    expect(capped.countCapped).toBe(true)
    expect(capped.truncated).toBe(true)
  })

  it('没有打开项目时返回空结果', () => {
    addDraft(1, 1, '林风')
    closeProjectDatabase()
    expect(search('林风').chapters).toEqual([])
  })
})

describe('makeSnippet', () => {
  it('不切开代理对', () => {
    // 前文只留 1 个码元会落在 emoji 的低位代理上：向前多带一个码元
    expect(makeSnippet('x😀关键词', 3, 3, 1, 10).before).toBe('…😀')
    // 后文只留 1 个码元会落在 emoji 的高位代理上：向后多带一个码元
    expect(makeSnippet('关键词😀yz', 0, 3, 5, 1).after).toBe('😀…')
  })

  it('正文以换行开头、命中在开头时不越界', () => {
    expect(makeSnippet('\n剑', 1, 1, 12, 40)).toEqual({ before: '', match: '剑', after: '' })
    expect(makeSnippet('剑\n后文', 0, 1, 12, 40)).toEqual({ before: '', match: '剑', after: '' })
  })
})

describe('validateChapterSearchArgs', () => {
  it('去掉首尾空白，缺省选项为 false', () => {
    expect(validateChapterSearchArgs({ query: '  林风 ' })).toEqual({
      query: '林风', options: { caseSensitive: false, finalizedOnly: false },
    })
    expect(validateChapterSearchArgs({ query: 'x', options: { finalizedOnly: true, extra: 1 } })).toEqual({
      query: 'x', options: { caseSensitive: false, finalizedOnly: true },
    })
  })

  it('拒绝空查询、超长查询、非字符串与非布尔选项', () => {
    expect(() => validateChapterSearchArgs({ query: '   ' })).toThrow(ValidationError)
    expect(() => validateChapterSearchArgs({ query: 'a'.repeat(MAX_SEARCH_QUERY_LEN + 1) })).toThrow(ValidationError)
    expect(() => validateChapterSearchArgs({ query: 42 })).toThrow(ValidationError)
    expect(() => validateChapterSearchArgs({ query: 'x', options: { caseSensitive: 'yes' } })).toThrow(ValidationError)
    expect(() => validateChapterSearchArgs({ query: 'x', options: [] })).toThrow(ValidationError)
    expect(() => validateChapterSearchArgs('x')).toThrow(ValidationError)
  })
})
