/**
 * 故事时间线视图的纯逻辑：筛选事件、按卷 / 章分组、挂上对应的卷摘要。
 *
 * 事件来自 Canon 时间线（定稿后处理自动提取，canon_timeline_events），
 * 卷的划分与分层摘要一致（每 ARC_SIZE 章一卷，见 narrative-consistency/arc-summary）。
 */
import { ARC_SIZE, arcRangeOf } from './narrative-consistency/arc-summary'
import type { CanonArcSummary, CanonTimelineEvent } from '../shared/ipc-channels'

export interface TimelineFilter {
  /** 关键词：按空白拆开后须全部命中（摘要、影响、地点、出场人物，不区分大小写）；空串不过滤 */
  keyword: string
  /** 是否包含闪回事件 */
  includeFlashback: boolean
}

export interface TimelineChapterGroup {
  chapterNumber: number
  /** 按 sequence 升序 */
  events: CanonTimelineEvent[]
}

export interface TimelineArcGroup {
  startChapter: number
  endChapter: number
  /** 该卷的卷摘要（尚未生成时为 undefined） */
  summary?: CanonArcSummary
  /** 按章节号升序，只含有事件的章 */
  chapters: TimelineChapterGroup[]
  eventCount: number
}

/** 拆出关键词（去空白、转小写）；没有关键词返回空数组 */
export function parseKeywords(keyword: string): string[] {
  return keyword.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesTimelineFilter(
  event: CanonTimelineEvent,
  filter: TimelineFilter,
  keywords = parseKeywords(filter.keyword),
): boolean {
  if (!filter.includeFlashback && event.timeFlow === 'flashback') return false
  if (keywords.length === 0) return true
  const haystack = [event.summary, event.impact, event.location, ...(event.characters ?? [])]
    .join('\n')
    .toLowerCase()
  return keywords.every(k => haystack.includes(k))
}

/**
 * 分组：卷按起始章升序，卷内章节升序、章内事件按 sequence 升序。
 * 不筛选时，只有卷摘要、还没有事件的卷也列出（早期项目的时间线可能没提取过）；
 * 有关键词或排除了闪回时只列出含匹配事件的卷。
 */
export function groupTimeline(
  events: CanonTimelineEvent[],
  arcSummaries: CanonArcSummary[],
  filter: TimelineFilter,
  arcSize = ARC_SIZE,
): TimelineArcGroup[] {
  const keywords = parseKeywords(filter.keyword)
  const filtering = keywords.length > 0 || !filter.includeFlashback
  const arcs = new Map<number, TimelineArcGroup>()
  const arcOf = (chapterNumber: number) => {
    const [start, end] = arcRangeOf(chapterNumber, arcSize)
    let group = arcs.get(start)
    if (!group) {
      group = { startChapter: start, endChapter: end, chapters: [], eventCount: 0 }
      arcs.set(start, group)
    }
    return group
  }

  const byChapter = new Map<number, CanonTimelineEvent[]>()
  for (const event of events) {
    if (!matchesTimelineFilter(event, filter, keywords)) continue
    const list = byChapter.get(event.chapterNumber)
    if (list) list.push(event)
    else byChapter.set(event.chapterNumber, [event])
  }

  for (const chapterNumber of [...byChapter.keys()].sort((a, b) => a - b)) {
    const list = byChapter.get(chapterNumber)!.sort((a, b) => a.sequence - b.sequence)
    const group = arcOf(chapterNumber)
    group.chapters.push({ chapterNumber, events: list })
    group.eventCount += list.length
  }

  for (const summary of arcSummaries) {
    if (summary.level !== 'arc' || !summary.summary.trim()) continue
    const [start] = arcRangeOf(summary.startChapter, arcSize)
    if (start !== summary.startChapter) continue // 与当前卷划分对不上的旧数据不挂
    const group = filtering ? arcs.get(start) : arcOf(start)
    if (group) group.summary = summary
  }

  return [...arcs.values()].sort((a, b) => a.startChapter - b.startChapter)
}

/** 全书摘要（没有时返回 undefined） */
export function findBookSummary(arcSummaries: CanonArcSummary[]): CanonArcSummary | undefined {
  return arcSummaries.find(s => s.level === 'book' && s.summary.trim())
}
