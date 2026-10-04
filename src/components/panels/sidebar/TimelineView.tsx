/**
 * TimelineView — 故事时间线（侧边栏面板，只读）
 *
 * 展示 Canon 时间线：定稿后处理从每章正文提取的事件（地点、出场人物、经过、影响），
 * 按卷（与分层摘要同一划分）和章分组，闪回单独标注；已生成的卷摘要 / 全书摘要一并显示。
 * 点击章节标题打开该章。这里不提供编辑：事件随章节重新定稿自动更新。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ChartGantt, RefreshCw, ChevronDown, ChevronRight, MapPin, Users, Rewind, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { groupTimeline, findBookSummary, type TimelineFilter } from '../../../services/timeline-view'
import { globalEventBus } from '../../../shared/event-bus'
import type { CanonArcSummary, CanonTimelineEvent } from '../../../shared/ipc-channels'
import { EmptyState } from '../../ui/EmptyState'
import { IconBtn } from '../../ui/IconBtn'
import { toast } from '../../ui/Toast'
import { resolveDraftTab, openDraftTab, activateOnKey } from './SidebarShared'

/** 取全部章节的事件：与 IPC 校验里章节号上限一致 */
const ALL_CHAPTERS = 1e9

const chevronStyle = { color: 'var(--color-text-muted)', flexShrink: 0 } as const

export default function TimelineView() {
  const { t } = useTranslation('panels')
  const projectPath = useProjectStore(s => s.currentProject?.path ?? null)
  const [events, setEvents] = useState<CanonTimelineEvent[]>([])
  const [arcSummaries, setArcSummaries] = useState<CanonArcSummary[]>([])
  const [titles, setTitles] = useState<Map<number, string>>(() => new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [includeFlashback, setIncludeFlashback] = useState(true)
  // null：还没初始化，拿到数据后默认只展开最后一卷
  const [expandedArcs, setExpandedArcs] = useState<Set<number> | null>(null)
  const [bookOpen, setBookOpen] = useState(false)
  const seqRef = useRef(0)
  /** 已见过的最后一卷的起始章：定稿进入新卷时据此自动展开新卷 */
  const lastArcRef = useRef(0)

  const load = useCallback(async () => {
    if (!projectPath) return
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const [timeline, arcs, blueprints] = await Promise.all([
        ipc.invoke('db:canon-timeline-get', ALL_CHAPTERS, true),
        ipc.invoke('db:canon-arc-summary-list'),
        ipc.invoke('db:blueprint-get-all'),
      ])
      if (seq !== seqRef.current) return // 切项目或重复刷新：丢弃过期结果
      setEvents(timeline ?? [])
      setArcSummaries(arcs ?? [])
      setTitles(new Map((blueprints ?? []).filter(b => b?.title).map(b => [b.chapterNumber, b.title])))
      setError(null)
    } catch (e) {
      if (seq !== seqRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [projectPath])

  // 打开 / 切换项目：清掉上一个项目的数据与展开状态后重新读取
  useEffect(() => {
    seqRef.current++
    lastArcRef.current = 0
    setEvents([])
    setArcSummaries([])
    setTitles(new Map())
    setExpandedArcs(null)
    setBookOpen(false)
    setError(null)
    void load()
  }, [load])

  // 定稿后处理会追加本章事件、每卷末章还会生成卷摘要
  useEffect(() => globalEventBus.on('FINALIZE_COMPLETE', () => { void load() }), [load])

  const filter = useMemo<TimelineFilter>(() => ({ keyword, includeFlashback }), [keyword, includeFlashback])
  const filtering = keyword.trim() !== '' || !includeFlashback
  const arcs = useMemo(() => groupTimeline(events, arcSummaries, filter), [events, arcSummaries, filter])
  const bookSummary = useMemo(() => findBookSummary(arcSummaries), [arcSummaries])

  // 默认只展开最后一卷（最近写到的地方）：长篇一次渲染几千条事件没有意义。
  // 之后定稿进入新的一卷时，把新卷也展开
  useEffect(() => {
    if (filtering || arcs.length === 0) return
    const last = arcs[arcs.length - 1].startChapter
    if (expandedArcs === null) {
      lastArcRef.current = last
      setExpandedArcs(new Set([last]))
    } else if (last > lastArcRef.current) {
      lastArcRef.current = last
      setExpandedArcs(prev => new Set(prev ?? []).add(last))
    }
  }, [arcs, expandedArcs, filtering])

  const toggleArc = (start: number) => {
    setExpandedArcs(prev => {
      const next = new Set(prev ?? [])
      if (next.has(start)) next.delete(start)
      else next.add(start)
      return next
    })
  }

  const chapterLabel = (chapterNumber: number) => {
    const title = titles.get(chapterNumber)
    return title
      ? t('manuscript.chapterFormatWithTitle', { number: chapterNumber, title })
      : t('manuscript.chapterFormat', { number: chapterNumber })
  }

  /** 打开该章：有定稿打开定稿，否则打开最新的未归档草稿 */
  const openChapter = async (chapterNumber: number) => {
    try {
      const finalized = await ipc.invoke('db:draft-get-finalized', chapterNumber)
      const target = finalized ?? (await ipc.invoke('db:draft-list', chapterNumber))
        .filter(d => d.status !== 'archived')
        .sort((a, b) => b.version - a.version)[0]
      if (!target) {
        toast.info(t('storyTimeline.noDraft'))
        return
      }
      const label = chapterLabel(chapterNumber)
      await openDraftTab(resolveDraftTab(target.id, !!finalized), finalized ? label : `${label} v${target.version}`)
    } catch (e) {
      toast.error(t('storyTimeline.openFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  if (!projectPath) {
    return <EmptyState icon={<ChartGantt size={36} />} message={t('storyTimeline.openProjectFirst')} className="pb-[15vh]" opacity={0.4} />
  }

  const shownEvents = arcs.reduce((n, arc) => n + arc.eventCount, 0)
  const shownChapters = arcs.reduce((n, arc) => n + arc.chapters.length, 0)
  let status: React.ReactNode
  if (error) status = <span style={{ color: 'var(--color-error)' }}>{t('storyTimeline.loadFailed', { error })}</span>
  else if (loading && events.length === 0) status = t('storyTimeline.loading')
  else if (events.length === 0) status = t('storyTimeline.empty')
  else if (filtering && shownEvents === 0) status = t('storyTimeline.noMatch')
  else status = t('storyTimeline.summary', { events: shownEvents, chapters: shownChapters })

  return (
    <div className="flex flex-col h-full text-sm">
      {/* 筛选 + 选项 */}
      <div className="px-2 pt-1 pb-1.5 flex flex-col gap-1">
        <div
          className="flex items-center gap-0.5 rounded-md pl-2 pr-0.5 h-7 focus-within:ring-2 focus-within:ring-[var(--color-accent)]"
          style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
        >
          <Search size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape' && keyword && !e.nativeEvent.isComposing) {
                e.preventDefault()
                setKeyword('')
              }
            }}
            placeholder={t('storyTimeline.filterPlaceholder')}
            aria-label={t('storyTimeline.filterPlaceholder')}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent text-xs outline-none px-1"
            style={{ color: 'var(--color-text)' }}
          />
          <IconBtn size={22} title={t('storyTimeline.includeFlashback')} active={includeFlashback} onClick={() => setIncludeFlashback(v => !v)}>
            <Rewind size={13} />
          </IconBtn>
          <IconBtn size={22} title={t('storyTimeline.refresh')} disabled={loading} onClick={() => { void load() }}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
          </IconBtn>
        </div>
        <div className="px-0.5 text-[0.7rem] leading-snug" style={{ color: 'var(--color-text-muted)' }} aria-live="polite">
          {status}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {/* 全书摘要（筛选时隐藏，避免与筛选结果混在一起） */}
        {bookSummary && !filtering && (
          <div className="mx-2 mb-1.5 rounded-md" style={{ border: '1px solid var(--color-border)' }}>
            <div
              className="tree-item gap-1 cursor-pointer select-none"
              style={{ paddingLeft: 6, paddingRight: 8 }}
              role="button"
              tabIndex={0}
              aria-expanded={bookOpen}
              onClick={() => setBookOpen(v => !v)}
              onKeyDown={e => activateOnKey(e, () => setBookOpen(v => !v))}
            >
              {bookOpen ? <ChevronDown size={12} style={chevronStyle} /> : <ChevronRight size={12} style={chevronStyle} />}
              <span className="text-xs font-medium flex-1 min-w-0 truncate" style={{ color: 'var(--color-text)' }}>
                {t('storyTimeline.bookSummary')}
              </span>
              <span className="text-[0.65rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                {t('storyTimeline.chapterRange', { start: bookSummary.startChapter, end: bookSummary.endChapter })}
              </span>
            </div>
            {bookOpen && (
              <p className="px-2.5 pb-2 text-xs whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                {bookSummary.summary}
              </p>
            )}
          </div>
        )}

        {arcs.map(arc => {
          // 筛选时全部展开：结果本来就少，折叠起来反而找不到
          const open = filtering || (expandedArcs?.has(arc.startChapter) ?? false)
          return (
            <div key={arc.startChapter}>
              <div
                className="tree-item gap-1 cursor-pointer select-none"
                style={{ paddingLeft: 6, paddingRight: 8 }}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggleArc(arc.startChapter)}
                onKeyDown={e => activateOnKey(e, () => toggleArc(arc.startChapter))}
              >
                {open ? <ChevronDown size={12} style={chevronStyle} /> : <ChevronRight size={12} style={chevronStyle} />}
                <span className="text-xs font-semibold truncate flex-1 min-w-0" style={{ color: 'var(--color-text)' }}>
                  {t('storyTimeline.chapterRange', { start: arc.startChapter, end: arc.endChapter })}
                  {arc.summary?.title ? ` · ${arc.summary.title}` : ''}
                </span>
                <span
                  className="text-[0.65rem] tabular-nums flex-shrink-0 px-1.5 rounded-full"
                  style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
                  title={t('storyTimeline.eventCountTitle')}
                >
                  {arc.eventCount}
                </span>
              </div>

              {open && (
                <div className="pb-1">
                  {arc.summary && (
                    <p
                      className="mx-2 mb-1 px-2 py-1.5 rounded text-[0.7rem] leading-relaxed whitespace-pre-wrap"
                      style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
                    >
                      <span className="font-medium" style={{ color: 'var(--color-text-muted)' }}>{t('storyTimeline.arcSummary')}</span>
                      {arc.summary.summary}
                    </p>
                  )}

                  {arc.chapters.map(ch => (
                    <div key={ch.chapterNumber} className="mb-0.5">
                      <div
                        className="tree-item gap-1.5 cursor-pointer"
                        style={{ paddingLeft: 18, paddingRight: 8 }}
                        role="button"
                        tabIndex={0}
                        onClick={() => { void openChapter(ch.chapterNumber) }}
                        onKeyDown={e => activateOnKey(e, () => { void openChapter(ch.chapterNumber) })}
                        title={t('storyTimeline.openChapter')}
                      >
                        <span className="text-xs font-medium truncate flex-1 min-w-0" style={{ color: 'var(--color-text)' }}>
                          {chapterLabel(ch.chapterNumber)}
                        </span>
                      </div>

                      <ol className="mr-2" style={{ marginLeft: 22, paddingLeft: 12, borderLeft: '1px solid var(--color-border)' }}>
                        {ch.events.map(ev => {
                          const flashback = ev.timeFlow === 'flashback'
                          return (
                            <li key={ev.id ?? `${ev.chapterNumber}-${ev.sequence}`} className="relative py-1">
                              {/* 时间轴上的节点：闪回用警示色 */}
                              <span
                                aria-hidden
                                className="absolute rounded-full"
                                style={{
                                  left: -16, top: 9, width: 7, height: 7,
                                  backgroundColor: flashback ? 'var(--color-warning)' : 'var(--color-accent)',
                                  boxShadow: '0 0 0 2px var(--color-sidebar)',
                                }}
                              />
                              {(flashback || ev.location || ev.characters.length > 0) && (
                                <div className="flex items-center gap-1.5 flex-wrap text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>
                                  {flashback && (
                                    <span className="px-1 rounded" style={{ color: 'var(--color-warning)', border: '1px solid currentColor' }}>
                                      {t('storyTimeline.flashback')}
                                    </span>
                                  )}
                                  {ev.location && (
                                    <span className="inline-flex items-center gap-0.5">
                                      <MapPin size={10} aria-hidden />
                                      <span className="sr-only">{t('storyTimeline.location')}</span>
                                      {ev.location}
                                    </span>
                                  )}
                                  {ev.characters.length > 0 && (
                                    <span className="inline-flex items-center gap-0.5 min-w-0">
                                      <Users size={10} aria-hidden />
                                      <span className="sr-only">{t('storyTimeline.characters')}</span>
                                      <span className="truncate">{ev.characters.join(t('storyTimeline.characterSeparator'))}</span>
                                    </span>
                                  )}
                                </div>
                              )}
                              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>{ev.summary}</p>
                              {ev.impact && (
                                <p className="text-[0.7rem] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                                  {t('storyTimeline.impact', { impact: ev.impact })}
                                </p>
                              )}
                            </li>
                          )
                        })}
                      </ol>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
