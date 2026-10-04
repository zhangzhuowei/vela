/**
 * ChapterSearchRepository — 跨章节全文搜索（全局搜索面板）
 *
 * 每章只搜一份「代表稿」：有定稿用定稿（版本最高的一份），否则用最新的未归档草稿；
 * 归档（软删除）的草稿不参与。
 *
 * 匹配放在 JS 里做而不是 SQL LIKE：SQLite 自带的 lower()/LIKE 只折叠 ASCII 大小写，
 * 俄文等西里尔字母做不了不区分大小写匹配，LIKE 也给不出命中位置。
 * 正文按行流式读取（iterate），不会一次把全书正文读进内存。
 */
import { getProjectDb } from '../database'
import { buildLiteralMatcher, normalizeLineEndings } from '../../src/shared/text-search'

export interface ChapterSearchOptions {
  /** 区分大小写（默认不区分） */
  caseSensitive?: boolean
  /** 只搜定稿章节（默认 false：未定稿的章节搜最新草稿） */
  finalizedOnly?: boolean
}

export interface ChapterSearchHit {
  /** 命中在正文中的起始偏移（UTF-16 码元；换行已统一为 \n，与编辑器文档坐标一致） */
  offset: number
  /** 命中长度（不区分大小写时可能与查询词长度不同） */
  length: number
  /** 命中所在段落内的前文（不跨段；截断时以 … 开头） */
  before: string
  /** 原文中的命中文本（保留原文大小写） */
  match: string
  /** 命中所在段落内的后文（不跨段；截断时以 … 结尾） */
  after: string
}

export interface ChapterSearchChapter {
  chapterNumber: number
  /** 蓝图标题，没有蓝图时为空串 */
  title: string
  /** 被搜索的那份稿子 */
  draftId: number
  version: number
  status: string
  /** 本章命中总数（可能多于 hits 条数） */
  matchCount: number
  hits: ChapterSearchHit[]
}

export interface ChapterSearchResult {
  chapters: ChapterSearchChapter[]
  /** 命中总数（countCapped 时只是下限） */
  totalMatches: number
  /** 有命中因条数上限没有返回明细 */
  truncated: boolean
  /** 命中过多已提前停止扫描：totalMatches 只是下限，排在后面的章节没有列出 */
  countCapped: boolean
  /** IPC 入参校验失败或查询出错时的原因（此时其余字段为空结果） */
  error?: string
}

export interface ChapterSearchLimits {
  /** 每章最多返回的命中明细 */
  hitsPerChapter: number
  /** 全部章节合计最多返回的命中明细（每个命中章节至少保留第一条，不受此限） */
  hitsTotal: number
  /** 计数上限：达到即停止扫描（单字、标点这类查询会命中几十万处） */
  maxCount: number
  /** 片段前文 / 后文长度（UTF-16 码元） */
  contextBefore: number
  contextAfter: number
}

/** 结果只用来渲染侧栏列表：全量返回明细没有意义，还会拖慢 IPC 和渲染 */
export const CHAPTER_SEARCH_LIMITS: ChapterSearchLimits = {
  hitsPerChapter: 20,
  hitsTotal: 300,
  maxCount: 50_000,
  // 侧栏一行只放得下二十来个汉字：前文太长会把命中挤出可视区
  contextBefore: 12,
  contextAfter: 40,
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** 取命中所在段落（行）内的前后文；不跨行，超长处截断并补 … */
export function makeSnippet(
  text: string,
  offset: number,
  length: number,
  contextBefore: number,
  contextAfter: number,
): Pick<ChapterSearchHit, 'before' | 'match' | 'after'> {
  const end = offset + length
  // offset 为 0 时 lastIndexOf 的起点会被钳到 0，正文恰好以换行开头就会算错，单独处理
  const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  const nextBreak = text.indexOf('\n', end)
  const lineEnd = nextBreak < 0 ? text.length : nextBreak

  let start = Math.max(lineStart, offset - contextBefore)
  let stop = Math.min(lineEnd, end + contextAfter)
  // 不切开代理对（emoji、生僻字）
  if (start > lineStart && isLowSurrogate(text.charCodeAt(start))) start--
  if (stop < lineEnd && isHighSurrogate(text.charCodeAt(stop - 1))) stop++

  const before = (start > lineStart ? '…' : '') + text.slice(start, offset).trimStart()
  const after = text.slice(end, stop).trimEnd() + (stop < lineEnd ? '…' : '')
  return { before, match: text.slice(offset, end), after }
}

interface SearchRow {
  id: number
  chapter_number: number
  version: number
  status: string | null
  body: string | null
  title: string | null
}

export class ChapterSearchRepository {
  /** 在各章代表稿里搜索字面量 query（首尾空白忽略） */
  static search(
    query: string,
    options: ChapterSearchOptions = {},
    limits: ChapterSearchLimits = CHAPTER_SEARCH_LIMITS,
  ): ChapterSearchResult {
    const result: ChapterSearchResult = { chapters: [], totalMatches: 0, truncated: false, countCapped: false }
    const db = getProjectDb()
    const needle = query.trim()
    if (!db || !needle) return result

    const matcher = buildLiteralMatcher(needle, options.caseSensitive === true)
    // 代表稿：同章里定稿优先，其次版本最高；归档稿不参与
    const rows = db.prepare(`
      SELECT d.id, d.chapter_number, d.version, d.status, c.body, b.title
      FROM drafts d
      JOIN contents c ON c.id = d.content_id
      LEFT JOIN blueprints b ON b.chapter_number = d.chapter_number
      WHERE d.id = (
        SELECT d2.id FROM drafts d2
        WHERE d2.chapter_number = d.chapter_number
          AND COALESCE(d2.status, 'draft') <> 'archived'
        ORDER BY (d2.status = 'finalized') DESC, d2.version DESC, d2.id DESC
        LIMIT 1
      )
      AND (? = 0 OR d.status = 'finalized')
      ORDER BY d.chapter_number ASC
    `).iterate(options.finalizedOnly ? 1 : 0) as IterableIterator<SearchRow>

    let hitsReturned = 0
    for (const row of rows) {
      const text = normalizeLineEndings(row.body ?? '')
      const hits: ChapterSearchHit[] = []
      let count = 0
      matcher.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = matcher.exec(text)) !== null) {
        count++
        const len = m[0].length
        if (hits.length === 0 || (hits.length < limits.hitsPerChapter && hitsReturned < limits.hitsTotal)) {
          hits.push({ offset: m.index, length: len, ...makeSnippet(text, m.index, len, limits.contextBefore, limits.contextAfter) })
          hitsReturned++
        }
        if (result.totalMatches + count >= limits.maxCount) {
          result.countCapped = true
          break
        }
        // 防御：查询非空时不会出现空匹配，万一出现也不能原地死循环
        if (len === 0) matcher.lastIndex++
      }

      if (count > 0) {
        result.chapters.push({
          chapterNumber: row.chapter_number,
          title: row.title ?? '',
          draftId: row.id,
          version: row.version,
          status: row.status ?? 'draft',
          matchCount: count,
          hits,
        })
        result.totalMatches += count
        if (hits.length < count) result.truncated = true
      }
      // 提前结束 for...of 会调用迭代器的 return()，语句随之释放
      if (result.countCapped) break
    }

    if (result.countCapped) result.truncated = true
    return result
  }
}
