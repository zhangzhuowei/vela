/**
 * 分层摘要（卷摘要 / 全书摘要）的纯逻辑：卷的划分、生成输入的整理、写作时远期记忆的选取与格式化。
 *
 * 写长篇时 Canon Context 只带最近几章的章节摘要，几十章之前的主线走向、人物关系变化会逐渐「失忆」。
 * 分层摘要补上这一层：每卷最后一章定稿时由 LLM 把本卷各章要点压成卷摘要，再由各卷摘要汇总成全书摘要。
 * LLM 调用放在定稿后处理（workflows/commands/finalize-chapter.command.ts），这里不依赖工作流层。
 */
import type { ArcSummary, ChapterSummary } from './types'

/** 每卷章数：第 1-10 章为第 1 卷，第 11-20 章为第 2 卷，依此类推 */
export const ARC_SIZE = 10

/** 有全书摘要时，额外附带最近几卷的卷摘要作为细节补充 */
const DETAIL_ARCS_WITH_BOOK = 2
/** 远期记忆里最多放几卷卷摘要 */
const MAX_ARCS = 6
/** 单条摘要注入 prompt 的长度上限 */
const MAX_BOOK_CHARS = 2400
const MAX_ARC_CHARS = 900

/** 章节所在卷的起止章（含两端） */
export function arcRangeOf(chapterNumber: number, arcSize = ARC_SIZE): [number, number] {
  const index = Math.floor((Math.max(1, Math.trunc(chapterNumber)) - 1) / arcSize)
  return [index * arcSize + 1, (index + 1) * arcSize]
}

/** 是否为某卷的最后一章：定稿到这一章时生成该卷的卷摘要，并刷新全书摘要 */
export function isArcEnd(chapterNumber: number, arcSize = ARC_SIZE): boolean {
  return Number.isInteger(chapterNumber) && chapterNumber > 0 && chapterNumber % arcSize === 0
}

/** 转义模板变量（防止摘要里的 {{xxx}} 被 prompt-builder 当成占位符替换） */
function escapeTemplateVars(text: string): string {
  return text.replace(/\{\{/g, '⦃⦃').replace(/\}\}/g, '⦄⦄')
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** 卷摘要的生成输入：本卷各章要点（每章截断，控制 prompt 长度） */
export function formatChapterSummariesForArc(summaries: ChapterSummary[], perChapterLimit = 600): string {
  return summaries
    .filter((s) => s.summary?.trim())
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .map((s) => `【第${s.chapterNumber}章${s.title ? ' ' + s.title : ''}】\n${clip(s.summary, perChapterLimit)}`)
    .join('\n\n')
}

/** 全书摘要的生成输入：各卷卷摘要，按章节顺序 */
export function formatArcSummariesForBook(arcs: ArcSummary[]): string {
  return arcs
    .filter((a) => a.level === 'arc' && a.summary.trim())
    .sort((a, b) => a.startChapter - b.startChapter)
    .map((a) => `【第${a.startChapter}-${a.endChapter}章】\n${a.summary.trim()}`)
    .join('\n\n')
}

/**
 * 写第 chapterNumber 章时注入的远期记忆。
 * - 只用完全位于本章之前的卷与全书摘要：重写早期章节时不会把后文剧情泄露进来
 * - 有可用的全书摘要：全书摘要 + 最近两卷 + 全书摘要尚未覆盖到的卷（全书摘要可能因生成失败而滞后）
 * - 没有：最近若干卷的卷摘要
 * 没有任何分层摘要时返回空串（渲染时整段省略）。
 */
export function selectLongTermSummary(all: ArcSummary[], chapterNumber: number): string {
  const arcs = all
    .filter((a) => a.level === 'arc' && a.endChapter < chapterNumber && a.summary.trim())
    .sort((a, b) => a.startChapter - b.startChapter)
  const book = all.find((a) => a.level === 'book' && a.endChapter < chapterNumber && a.summary.trim())

  let picked: ArcSummary[]
  if (book) {
    const detail = new Set(arcs.slice(-DETAIL_ARCS_WITH_BOOK))
    picked = arcs.filter((a) => detail.has(a) || a.startChapter > book.endChapter).slice(-MAX_ARCS)
  } else {
    picked = arcs.slice(-MAX_ARCS)
  }

  const parts: string[] = []
  if (book) parts.push(`《全书摘要（第1-${book.endChapter}章）》\n${clip(book.summary, MAX_BOOK_CHARS)}`)
  for (const a of picked) {
    parts.push(`《卷摘要（第${a.startChapter}-${a.endChapter}章）》\n${clip(a.summary, MAX_ARC_CHARS)}`)
  }
  return escapeTemplateVars(parts.join('\n\n'))
}
