import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addChunks, listDocuments, removeDocument, searchWithScope, closeConnection,
  sqlString, buildChapterScopeFilter, buildLikePattern,
} from '../vector-store'

describe('vector-store：过滤表达式拼接', () => {
  it('字符串字面量把单引号加倍', () => {
    expect(sqlString('abc')).toBe("'abc'")
    expect(sqlString("x' OR '1'='1")).toBe("'x'' OR ''1''=''1'")
  })

  it('章节范围只接受整数', () => {
    expect(buildChapterScopeFilter([1, 5])).toBe('chapterNumber >= 1 AND chapterNumber <= 5')
    expect(buildChapterScopeFilter(['3', '4'])).toBe('chapterNumber >= 3 AND chapterNumber <= 4')
    expect(buildChapterScopeFilter(['0 OR 1=1', 5])).toBeNull()
    expect(buildChapterScopeFilter([1.5, 5])).toBeNull()
    expect(buildChapterScopeFilter([Number.NaN, 5])).toBeNull()
  })

  it('LIKE 模式逐字转义单引号，不会把 \'\' 拆成两个孤立引号', () => {
    expect(buildLikePattern('ab')).toBe('%a%b%')
    expect(buildLikePattern("it's")).toBe("%i%t%''%s%")
  })
})

describe('vector-store：LanceDB 读写（真实库，临时目录）', () => {
  let project: string

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-lance-'))
  })

  afterEach(() => {
    // 先释放连接句柄，Windows 上才能删掉目录
    closeConnection(project)
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('删除文档：注入式的 docId 不会误删其他文档；标题预览取首块首行', async () => {
    await addChunks(project, 'doc-a', 'a.md', ['# 第一卷 风起\n\n正文 A'], undefined, 'C:\\src\\a.md')
    await addChunks(project, 'doc-b', 'b.md', ['第二卷\n正文 B'], undefined, 'C:\\src\\b.md')

    expect(await removeDocument(project, "x' OR '1'='1")).toBe(true)
    let docs = await listDocuments(project)
    expect(docs.map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b'])
    expect(docs.find((d) => d.id === 'doc-a')?.preview).toBe('# 第一卷 风起')

    expect(await removeDocument(project, 'doc-a')).toBe(true)
    docs = await listDocuments(project)
    expect(docs.map((d) => d.id)).toEqual(['doc-b'])
  })

  it('章节范围检索：非整数范围直接拒绝；带撇号的短查询走 LIKE 兜底也不再报错', async () => {
    await addChunks(project, 'ch1', '第1章 甲.txt', ["It's chapter one."], undefined, undefined, { chapterNumber: 1, chapterTitle: '甲' })
    await addChunks(project, 'ch9', '第9章 乙.txt', ['Chapter nine, no quote.'], undefined, undefined, { chapterNumber: 9, chapterTitle: '乙' })

    const injected = await searchWithScope(project, 'chapter', undefined, 5, ['0 OR 1=1', 99] as unknown as [number, number])
    expect(injected).toEqual([])

    // 单字符查询构不成 FTS 双字组，走逐字 LIKE：以前会拼出坏掉的 SQL 而静默返回空
    const quoted = await searchWithScope(project, "'", undefined, 5)
    expect(quoted.map((r) => r.fileName)).toEqual(['第1章 甲.txt'])

    const scoped = await searchWithScope(project, "'", undefined, 5, [5, 10])
    expect(scoped).toEqual([])
  })
})
