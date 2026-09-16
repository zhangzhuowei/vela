import { useEffect, useRef, useState } from 'react'
import { Library, Play, RotateCcw, GitBranch, PackagePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../stores/project-store'
import { useReferenceStore } from '../../stores/reference-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { createReferenceDigestWorkflow, createReferenceOutlineWorkflow, createReferenceRerunWorkflow } from '../../services/workflows/reference-workflow'
import { nextDigestRange } from '../../services/reference/analyzed-range'
import type { RefRefineScope, RefRerunScope } from '../../services/workflows/commands/reference-analysis.command'
import { ipc } from '../../services/ipc-client'
import { globalEventBus } from '../../shared/event-bus'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { NativeSelect } from '../ui/NativeSelect'
import { toast } from '../ui/Toast'
import { cn } from '../../lib/utils'
import CollapseTitle from '../reference/CollapseTitle'
import LineEditor from '../reference/LineEditor'
import OutlineTab from '../reference/OutlineTab'
import RefinePanel from '../reference/RefinePanel'
import BookSeedPanel, { type BookSeedPanelInitial } from '../reference/BookSeedPanel'
import ExportRecordsTab from '../reference/ExportRecordsTab'

type Tab = 'outline' | 'lines' | 'digests' | 'exports'

/** 命令末尾的 REFRESH_RESOURCE 与 WORKFLOW_COMPLETE 几乎同时到，合并成一次刷新 */
const RELOAD_DEBOUNCE_MS = 200

export default function ReferenceOverview() {
  const { t } = useTranslation('pages')
  const currentProject = useProjectStore((s) => s.currentProject)
  const models = useLLMStore((s) => s.models)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const analyzing = useWorkflowStore((s) => s.activeRuns.some((r) => r.type === 'reference_analysis'))
  const {
    works, selectedWorkId, chapters, digests, lines, stages, outlineL2, outlineL3, revisions, exports, loading, reloadSelected, deleteExport,
  } = useReferenceStore()
  const [tab, setTab] = useState<Tab>('outline')
  const [refine, setRefineState] = useState<{ scope: RefRefineScope; label: string } | null>(null)
  const [seedPanel, setSeedPanel] = useState<{ initial: BookSeedPanelInitial | null } | null>(null)
  // 右侧只放一个面板：打开微调就收起生成面板，反之亦然
  const setRefine = (v: { scope: RefRefineScope; label: string } | null) => {
    if (v) setSeedPanel(null)
    setRefineState(v)
  }
  const openSeedPanel = (initial: BookSeedPanelInitial | null) => {
    setRefineState(null)
    setSeedPanel({ initial })
  }
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, defaultOpen = true) => (collapsed[key] === undefined ? defaultOpen : !collapsed[key])
  const toggle = (key: string, defaultOpen = true) => {
    setCollapsed((c) => {
      const currentlyOpen = c[key] === undefined ? defaultOpen : !c[key]
      return { ...c, [key]: currentlyOpen }
    })
  }

  const work = works.find((w) => w.id === selectedWorkId) ?? null
  const failed = digests.filter((d) => d.status === 'failed')
  const okNums = new Set(digests.filter((d) => d.status === 'ok').map((d) => d.chapterNumber))
  const pendingNums = chapters.map((c) => c.number).filter((n) => !okNums.has(n)).sort((a, b) => a - b)
  const busy = !!work && (work.status === 'running' || analyzing)
  const canContinue = !!work && !busy && pendingNums.length > 0
  const canOutline = !!work && !busy && okNums.size > 0 && lines.length > 0
  const canSeed = !!work && !busy && !!outlineL2?.body
  const digestCandidates = models.filter((m) => m.purposes.includes('summary') || m.purposes.includes('generation'))
  const outlineCandidates = models.filter((m) => m.purposes.includes('generation'))

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const scheduleReload = () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null
        void reloadSelected()
      }, RELOAD_DEBOUNCE_MS)
    }
    const offRefresh = globalEventBus.on('REFRESH_RESOURCE', (payload) => {
      if (payload.resources.includes('all') || payload.resources.includes('references')) scheduleReload()
    })
    const offDone = globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      if (payload.type === 'reference_analysis') scheduleReload()
    })
    return () => {
      offRefresh()
      offDone()
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    }
  }, [reloadSelected])

  const handleContinue = async () => {
    if (!work) return
    const pending = await ipc.invoke('db:ref-chapter-pending', work.id, 1, work.totalChapters)
    const range = nextDigestRange(pending, work.totalChapters)
    if (!range) return
    await startWorkflow(createReferenceDigestWorkflow({
      workId: work.id, workName: work.name, from: range.from, to: range.to,
    }), false)
  }

  const handleRetryFailed = async () => {
    if (!work || failed.length === 0) return
    const nums = failed.map((d) => d.chapterNumber)
    await startWorkflow(createReferenceDigestWorkflow({
      workId: work.id, workName: work.name, from: Math.min(...nums), to: Math.max(...nums), onlyChapters: nums,
    }), false)
  }

  const handleOutline = async () => {
    if (!work) return
    await startWorkflow(createReferenceOutlineWorkflow({ workId: work.id, workName: work.name }), false)
  }

  const startRerun = (scope: RefRerunScope, label: string) => {
    if (!work || busy) return
    void startWorkflow(createReferenceRerunWorkflow({
      workId: work.id, workName: work.name, scope, scopeLabel: label,
    }), false)
  }

  const saveModel = async (field: 'digestModelId' | 'outlineModelId', value: string) => {
    if (!work || busy) return
    const res = await ipc.invoke('db:ref-work-upsert', { ...work, [field]: value })
    if (!res.success) {
      toast.error(res.error || t('reference.header.modelSaveFailed'))
      return
    }
    await reloadSelected()
  }

  if (!currentProject || !work) {
    return (
      <EmptyState
        icon={<Library size={40} />}
        message={t('reference.noSelection')}
        opacity={0.4}
      />
    )
  }

  const chapterTitle = (n: number) => chapters.find((c) => c.number === n)?.title || ''
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'outline', label: t('reference.tabOutline') },
    { id: 'lines', label: t('reference.tabLines') },
    { id: 'digests', label: t('reference.tabDigests') },
    { id: 'exports', label: t('reference.tabExports') },
  ]

  return (
    <div className="w-full h-full flex overflow-hidden" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-medium truncate">{work.name}</h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                {t('reference.header.chapters', { count: work.totalChapters })}
                {' · '}
                {t('reference.header.analyzed', { from: work.analyzedFrom, to: work.analyzedTo })}
                {' · '}
                {t(`reference.status.${work.status}`)}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                  <span className="flex-shrink-0">{t('reference.header.digestModel')}</span>
                  <NativeSelect
                    className="w-44"
                    value={work.digestModelId}
                    disabled={busy}
                    onChange={(e) => void saveModel('digestModelId', e.target.value)}
                  >
                    <option value="">{t('reference.header.defaultModel')}</option>
                    {digestCandidates.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                    {work.digestModelId && !digestCandidates.some((m) => m.id === work.digestModelId) && (
                      <option value={work.digestModelId}>{work.digestModelId}</option>
                    )}
                  </NativeSelect>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                  <span className="flex-shrink-0">{t('reference.header.outlineModel')}</span>
                  <NativeSelect
                    className="w-44"
                    value={work.outlineModelId}
                    disabled={busy}
                    onChange={(e) => void saveModel('outlineModelId', e.target.value)}
                  >
                    <option value="">{t('reference.header.defaultModel')}</option>
                    {outlineCandidates.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                    {work.outlineModelId && !outlineCandidates.some((m) => m.id === work.outlineModelId) && (
                      <option value={work.outlineModelId}>{work.outlineModelId}</option>
                    )}
                  </NativeSelect>
                </label>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button size="sm" variant="outline" disabled={!canContinue || loading} onClick={() => void handleContinue()}>
                <Play size={12} />
                {t('reference.continue')}
              </Button>
              <Button size="sm" variant="outline" disabled={failed.length === 0 || work.status === 'running'} onClick={() => void handleRetryFailed()}>
                <RotateCcw size={12} />
                {t('reference.retryFailed')}
              </Button>
              <Button size="sm" disabled={!canOutline || loading} onClick={() => void handleOutline()}>
                <GitBranch size={12} />
                {t('reference.runOutline')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canSeed || loading}
                title={canSeed ? undefined : t('reference.bookSeed.needL2Hint')}
                onClick={() => openSeedPanel(null)}
              >
                <PackagePlus size={12} />
                {t('reference.bookSeed.open')}
              </Button>
            </div>
          </div>
          <div className="flex gap-1">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'px-2.5 py-1 rounded text-xs',
                  tab === item.id ? 'bg-[var(--color-hover)] text-[var(--color-text)]' : 'text-[var(--color-text-muted)]',
                )}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {failed.length > 0 && tab === 'digests' && (
            <section>
              <h3 className="text-xs font-medium mb-2">{t('reference.failedTitle')}</h3>
              <ul className="space-y-1">
                {failed.map((d) => (
                  <li key={d.chapterNumber} className="text-xs text-[var(--color-danger,#dc2626)]">
                    {t('reference.failedItem', { chapter: d.chapterNumber, error: d.error })}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === 'exports' && (
            <section>
              <h3 className="text-xs font-medium mb-2">{t('reference.exports.title')}</h3>
              <ExportRecordsTab
                workName={work.name}
                records={exports}
                onDelete={deleteExport}
                onReuse={(initial) => openSeedPanel(initial)}
              />
            </section>
          )}

          {tab === 'digests' && (
            <section>
              <h3 className="text-xs font-medium mb-2">{t('reference.digestTitle')}</h3>
              <div className="space-y-2">
                {digests.length === 0 && (
                  <p className="text-xs text-[var(--color-text-muted)]">{t('reference.digestEmpty')}</p>
                )}
                {digests.map((d) => {
                  const label = t('reference.chapterHeading', { number: d.chapterNumber, title: chapterTitle(d.chapterNumber) })
                  const open = isOpen(`digest-${d.chapterNumber}`, false)
                  return (
                  <div
                    key={d.chapterNumber}
                    className={cn(
                      'rounded-lg px-3 py-2 border border-[var(--color-border)]',
                      d.status === 'failed' && 'opacity-70',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <CollapseTitle
                        open={open}
                        onToggle={() => toggle(`digest-${d.chapterNumber}`, false)}
                        title={label}
                        collapseLabel={t('reference.outline.collapse')}
                        expandLabel={t('reference.outline.expand')}
                      />
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRefine({ scope: { kind: 'digest', chapterNumber: d.chapterNumber }, label })}
                        >
                          {t('reference.outline.refine')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          title={t('reference.outline.rerunHint')}
                          onClick={() => startRerun({ kind: 'digest', chapterNumber: d.chapterNumber }, label)}
                        >
                          {t('reference.outline.rerun')}
                        </Button>
                      </div>
                    </div>
                    <p className="mt-0.5 text-[0.65rem] text-[var(--color-text-muted)]">
                      {d.activeLine
                        ? t('reference.activeLine', { name: d.activeLine })
                        : t('reference.activeLineNone')}
                      {d.intimate ? ` · ${t('reference.intimate')}` : ''}
                    </p>
                    {open && (
                      <>
                        {d.summary && (
                          <p className="mt-1 text-xs text-[var(--color-text-secondary)] leading-relaxed">{d.summary}</p>
                        )}
                        {d.characterStates.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {d.characterStates.map((s) => (
                              <span
                                key={`${d.chapterNumber}-${s.name}`}
                                className="px-1.5 py-0.5 rounded text-[0.65rem] bg-[var(--color-hover)] text-[var(--color-text-muted)]"
                              >
                                {s.name} · {s.stage}/{s.func}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  )
                })}
              </div>
            </section>
          )}

          {tab === 'lines' && (
            <LineEditor workId={work.id} digests={digests} lines={lines} reloadSelected={reloadSelected} />
          )}

          {tab === 'outline' && (
            <OutlineTab
              work={work}
              digests={digests}
              lines={lines}
              stages={stages}
              outlineL2={outlineL2}
              outlineL3={outlineL3}
              revisions={revisions}
              busy={busy}
              okCount={okNums.size}
              isOpen={isOpen}
              toggle={toggle}
              chapterTitle={chapterTitle}
              onRefine={(scope, label) => setRefine({ scope, label })}
              onRerun={startRerun}
              onOpenDigest={(ch) => {
                setTab('digests')
                setRefine({ scope: { kind: 'digest', chapterNumber: ch }, label: t('reference.chapterHeading', { number: ch, title: chapterTitle(ch) }) })
              }}
              reloadSelected={reloadSelected}
            />
          )}
        </div>
      </div>

      {refine && !seedPanel && (
        <RefinePanel
          key={JSON.stringify(refine.scope)}
          workId={work.id}
          workName={work.name}
          scope={refine.scope}
          scopeLabel={refine.label}
          onClear={() => setRefine(null)}
        />
      )}
      {seedPanel && (
        <BookSeedPanel
          workId={work.id}
          workName={work.name}
          defaultModelId={work.outlineModelId}
          busy={busy}
          initial={seedPanel.initial}
          onClose={() => setSeedPanel(null)}
        />
      )}
    </div>
  )
}
