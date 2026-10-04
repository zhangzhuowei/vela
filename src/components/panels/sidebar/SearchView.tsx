/**
 * SearchView — 跨章节全局搜索（侧边栏面板，Ctrl+Shift+F）
 *
 * 每章搜一份代表稿：已定稿的章节搜定稿，其余章节搜最新的未归档草稿（主进程 db:search-chapters）。
 * 结果按章分组；点击命中打开该章，并在编辑器里定位、高亮命中（见 services/editor-reveal）。
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, CaseSensitive, BadgeCheck, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../../stores/project-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { ipc } from '../../../services/ipc-client'
import { requestEditorReveal } from '../../../services/editor-reveal'
import { globalEventBus } from '../../../shared/event-bus'
import { EmptyState } from '../../ui/EmptyState'
import { IconBtn } from '../../ui/IconBtn'
import { resolveDraftTab, openDraftTab, activateOnKey } from './SidebarShared'
import type {
  ChapterSearchChapter, ChapterSearchHit, ChapterSearchResult, ChapterSearchOptions,
} from '../../../../electron/repositories/chapter-search-repository'

type SearchOptions = Required<ChapterSearchOptions>

/** 一次搜索的结果连同它对应的查询条件（定位命中时要用到当时的大小写选项） */
interface SearchOutcome extends ChapterSearchResult {
  query: string
  options: SearchOptions
}

/** 切走侧栏视图再回来时恢复上次的搜索词与选项（按项目区分） */
let lastSearch: { projectPath: string | null; query: string } & SearchOptions = {
  projectPath: null, query: '', caseSensitive: false, finalizedOnly: false,
}
/** 已处理过的 openSearch 请求，避免重新挂载时把旧的预填词再套用一遍 */
let handledSearchNonce = 0

/** 输入停顿多久后自动搜索 */
const SEARCH_DEBOUNCE_MS = 300

type Translate = (key: string, opts?: Record<string, unknown>) => string

/** 搜索条件指纹：变了才重置章节折叠状态 */
function outcomeKey(query: string, options: SearchOptions): string {
  return `${query}\u0000${options.caseSensitive ? 1 : 0}${options.finalizedOnly ? 1 : 0}`
}

function chapterLabel(t: Translate, ch: ChapterSearchChapter): string {
  return ch.title
    ? t('manuscript.chapterFormatWithTitle', { number: ch.chapterNumber, title: ch.title })
    : t('manuscript.chapterFormat', { number: ch.chapterNumber })
}

export default function SearchView() {
  const { t } = useTranslation('panels')
  const projectPath = useProjectStore(s => s.currentProject?.path ?? null)
  const searchRequest = useLayoutStore(s => s.searchRequest)

  const restored = lastSearch.projectPath === projectPath ? lastSearch : null
  const [query, setQuery] = useState(restored?.query ?? '')
  const [caseSensitive, setCaseSensitive] = useState(restored?.caseSensitive ?? false)
  const [finalizedOnly, setFinalizedOnly] = useState(restored?.finalizedOnly ?? false)
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  // 输入法组字期间不搜索（拼音字母不是用户要找的词）；组字结束后用 composeTick 触发一次
  const composingRef = useRef(false)
  const [composeTick, setComposeTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const seqRef = useRef(0)
  const outcomeKeyRef = useRef('')

  const runSearch = useCallback(async (q: string, options: SearchOptions) => {
    const seq = ++seqRef.current
    const needle = q.trim()
    if (!needle) {
      outcomeKeyRef.current = ''
      setOutcome(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await ipc.invoke('db:search-chapters', needle, options)
      if (seq !== seqRef.current) return // 已有更新的搜索，丢弃过期结果
      // 换了搜索条件才重置折叠状态；同条件刷新（定稿后自动重搜）保留用户的折叠
      const key = outcomeKey(needle, options)
      if (key !== outcomeKeyRef.current) {
        outcomeKeyRef.current = key
        setCollapsed(new Set())
      }
      setOutcome({ ...res, query: needle, options })
      setError(res.error ?? null)
    } catch (e) {
      if (seq !== seqRef.current) return
      outcomeKeyRef.current = ''
      setOutcome(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  // 输入 / 选项 / 项目变化后防抖搜索
  useEffect(() => {
    lastSearch = { projectPath, query, caseSensitive, finalizedOnly }
    if (!projectPath) {
      seqRef.current++
      setOutcome(null)
      setError(null)
      setLoading(false)
      return
    }
    if (composingRef.current) return
    const timer = setTimeout(
      () => { void runSearch(query, { caseSensitive, finalizedOnly }) },
      query.trim() ? SEARCH_DEBOUNCE_MS : 0,
    )
    return () => clearTimeout(timer)
  }, [query, caseSensitive, finalizedOnly, projectPath, composeTick, runSearch])

  // 定稿会改变章节的代表稿与正文：有搜索词时自动重搜
  const latestRef = useRef({ query, caseSensitive, finalizedOnly })
  latestRef.current = { query, caseSensitive, finalizedOnly }
  useEffect(() => globalEventBus.on('FINALIZE_COMPLETE', () => {
    const { query: q, caseSensitive: cs, finalizedOnly: fo } = latestRef.current
    if (q.trim()) void runSearch(q, { caseSensitive: cs, finalizedOnly: fo })
  }), [runSearch])

  // Ctrl+Shift+F：聚焦输入框，有预填词（编辑器里选中的文字）时替换搜索词
  useEffect(() => {
    if (searchRequest.nonce !== handledSearchNonce) {
      handledSearchNonce = searchRequest.nonce
      if (searchRequest.text) setQuery(searchRequest.text)
    }
    const input = inputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [searchRequest])

  /** 打开命中所在章节并定位（先登记定位请求：编辑器可能已挂载，也可能随后才创建） */
  const openHit = async (ch: ChapterSearchChapter, hit: ChapterSearchHit, options: SearchOptions) => {
    const finalized = ch.status === 'finalized'
    const target = resolveDraftTab(ch.draftId, finalized)
    requestEditorReveal({
      filePath: target.filePath,
      from: hit.offset,
      to: hit.offset + hit.length,
      text: hit.match,
      caseSensitive: options.caseSensitive,
    })
    const label = chapterLabel(t, ch)
    await openDraftTab(target, finalized ? label : `${label} v${ch.version}`)
  }

  const toggleChapter = (chapterNumber: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(chapterNumber)) next.delete(chapterNumber)
      else next.add(chapterNumber)
      return next
    })
  }

  if (!projectPath) {
    return <EmptyState icon={<Search size={36} />} message={t('globalSearch.openProjectFirst')} className="pb-[15vh]" opacity={0.4} />
  }

  const trimmed = query.trim()

  return (
    <div className="flex flex-col h-full text-sm">
      {/* 搜索框 + 选项 */}
      <div className="px-2 pt-1 pb-1.5 flex flex-col gap-1">
        <div
          className="flex items-center gap-0.5 rounded-md pl-2 pr-0.5 h-7 focus-within:ring-2 focus-within:ring-[var(--color-accent)]"
          style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
        >
          <Search size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => {
              composingRef.current = false
              setComposeTick(n => n + 1)
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') {
                e.preventDefault()
                void runSearch(query, { caseSensitive, finalizedOnly })
              } else if (e.key === 'Escape' && query) {
                e.preventDefault()
                setQuery('')
              }
            }}
            placeholder={t('globalSearch.placeholder')}
            aria-label={t('globalSearch.placeholder')}
            spellCheck={false}
            maxLength={200}
            className="flex-1 min-w-0 bg-transparent text-xs outline-none px-1"
            style={{ color: 'var(--color-text)' }}
          />
          <IconBtn size={22} title={t('globalSearch.matchCase')} active={caseSensitive} onClick={() => setCaseSensitive(v => !v)}>
            <CaseSensitive size={14} />
          </IconBtn>
          <IconBtn size={22} title={t('globalSearch.finalizedOnly')} active={finalizedOnly} onClick={() => setFinalizedOnly(v => !v)}>
            <BadgeCheck size={13} />
          </IconBtn>
          <IconBtn
            size={22}
            title={t('globalSearch.refresh')}
            disabled={!trimmed || loading}
            onClick={() => { void runSearch(query, { caseSensitive, finalizedOnly }) }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
          </IconBtn>
        </div>

        {/* 状态行 */}
        <div className="px-0.5 text-[0.7rem] leading-snug" style={{ color: 'var(--color-text-muted)' }} aria-live="polite">
          {!trimmed && t('globalSearch.hint')}
          {trimmed && loading && !outcome && t('globalSearch.searching')}
          {trimmed && error && (
            <span style={{ color: 'var(--color-error)' }}>{t('globalSearch.failed', { error })}</span>
          )}
          {trimmed && !error && outcome && outcome.chapters.length === 0 && t('globalSearch.noResults', { query: outcome.query })}
          {trimmed && !error && outcome && outcome.chapters.length > 0 && (
            <>
              <span>{t('globalSearch.summary', { count: outcome.totalMatches, chapters: outcome.chapters.length })}</span>
              {outcome.countCapped && (
                <span className="block" style={{ color: 'var(--color-warning)' }}>
                  {t('globalSearch.capped', { count: outcome.totalMatches })}
                </span>
              )}
              {!outcome.countCapped && outcome.truncated && (
                <span className="block">{t('globalSearch.truncated')}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* 结果：按章分组 */}
      {trimmed && !error && outcome && outcome.chapters.length > 0 && (
        <div className="flex-1 overflow-y-auto pb-2" style={{ opacity: loading ? 0.6 : 1 }}>
          {outcome.chapters.map(ch => {
            const isCollapsed = collapsed.has(ch.chapterNumber)
            const hidden = ch.matchCount - ch.hits.length
            return (
              <div key={ch.chapterNumber}>
                <div
                  className="tree-item gap-1 cursor-pointer select-none"
                  style={{ paddingLeft: 6, paddingRight: 8 }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleChapter(ch.chapterNumber)}
                  onKeyDown={e => activateOnKey(e, () => toggleChapter(ch.chapterNumber))}
                  title={chapterLabel(t, ch)}
                >
                  {isCollapsed
                    ? <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                    : <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />}
                  <span className="text-xs font-medium truncate flex-1 min-w-0" style={{ color: 'var(--color-text)' }}>
                    {chapterLabel(t, ch)}
                  </span>
                  <span
                    className="text-[0.65rem] flex-shrink-0"
                    style={{ color: ch.status === 'finalized' ? 'var(--color-success)' : 'var(--color-text-muted)' }}
                  >
                    {ch.status === 'finalized'
                      ? t('draftStatus.finalized')
                      : `v${ch.version} · ${t(`draftStatus.${ch.status}`, { defaultValue: ch.status })}`}
                  </span>
                  <span
                    className="text-[0.65rem] tabular-nums flex-shrink-0 px-1.5 rounded-full"
                    style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
                  >
                    {ch.matchCount}
                  </span>
                </div>
                {!isCollapsed && (
                  <>
                    {ch.hits.map(hit => (
                      <div
                        key={hit.offset}
                        className="tree-item cursor-pointer"
                        style={{ paddingLeft: 24, paddingRight: 8 }}
                        role="button"
                        tabIndex={0}
                        onClick={() => { void openHit(ch, hit, outcome.options) }}
                        onKeyDown={e => activateOnKey(e, () => { void openHit(ch, hit, outcome.options) })}
                        title={`${hit.before}${hit.match}${hit.after}`}
                      >
                        <span className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
                          {hit.before}
                          <mark
                            className="rounded-sm px-px"
                            style={{ backgroundColor: 'rgba(var(--color-accent-rgb), 0.32)', color: 'var(--color-text)' }}
                          >
                            {hit.match}
                          </mark>
                          {hit.after}
                        </span>
                      </div>
                    ))}
                    {hidden > 0 && (
                      <div className="text-[0.65rem] py-0.5" style={{ paddingLeft: 24, color: 'var(--color-text-muted)' }}>
                        {t('globalSearch.moreInChapter', { count: hidden })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
