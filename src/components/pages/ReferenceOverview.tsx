import { useEffect } from 'react'
import { Library, Play, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../stores/project-store'
import { useReferenceStore } from '../../stores/reference-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { createReferenceDigestWorkflow } from '../../services/workflows/reference-workflow'
import { globalEventBus } from '../../shared/event-bus'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { cn } from '../../lib/utils'

export default function ReferenceOverview() {
  const { t } = useTranslation('pages')
  const currentProject = useProjectStore((s) => s.currentProject)
  const models = useLLMStore((s) => s.models)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const {
    works, selectedWorkId, chapters, digests, loading, reloadSelected,
  } = useReferenceStore()

  const work = works.find((w) => w.id === selectedWorkId) ?? null
  const failed = digests.filter((d) => d.status === 'failed')
  const nextFrom = work ? work.analyzedTo + 1 : 1
  const canContinue = !!work && work.status !== 'running' && nextFrom <= work.totalChapters
  const modelLabel = (id: string) => {
    if (!id) return t('reference.header.defaultModel')
    return models.find((m) => m.id === id)?.name || id
  }

  useEffect(() => {
    const offRefresh = globalEventBus.on('REFRESH_RESOURCE', (payload) => {
      if (payload.resources.includes('all') || payload.resources.includes('references')) {
        void reloadSelected()
      }
    })
    const offDone = globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      if (payload.type === 'reference_analysis') void reloadSelected()
    })
    return () => {
      offRefresh()
      offDone()
    }
  }, [reloadSelected])

  const handleContinue = async () => {
    if (!work) return
    const to = Math.min(work.totalChapters, nextFrom + 199)
    await startWorkflow(createReferenceDigestWorkflow({
      workId: work.id, workName: work.name, from: nextFrom, to,
    }), false)
  }

  const handleRetryFailed = async () => {
    if (!work || failed.length === 0) return
    const nums = failed.map((d) => d.chapterNumber)
    await startWorkflow(createReferenceDigestWorkflow({
      workId: work.id, workName: work.name, from: Math.min(...nums), to: Math.max(...nums),
    }), false)
  }

  if (!currentProject) {
    return (
      <EmptyState
        icon={<Library size={40} />}
        message={t('reference.noSelection')}
        opacity={0.4}
      />
    )
  }

  if (!work) {
    return (
      <EmptyState
        icon={<Library size={40} />}
        message={t('reference.noSelection')}
        opacity={0.4}
      />
    )
  }

  const chapterTitle = (n: number) => chapters.find((c) => c.number === n)?.title || ''

  return (
    <div className="w-full h-full flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
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
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {t('reference.header.models', {
                digest: modelLabel(work.digestModelId),
                outline: modelLabel(work.outlineModelId),
              })}
            </p>
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
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {failed.length > 0 && (
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

        <section>
          <h3 className="text-xs font-medium mb-2">{t('reference.digestTitle')}</h3>
          <div className="space-y-2">
            {digests.length === 0 && (
              <p className="text-xs text-[var(--color-text-muted)]">{t('reference.digestEmpty')}</p>
            )}
            {digests.map((d) => (
              <div
                key={d.chapterNumber}
                className={cn(
                  'rounded-lg px-3 py-2 border border-[var(--color-border)]',
                  d.status === 'failed' && 'opacity-70',
                )}
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium">
                    {t('reference.chapterHeading', { number: d.chapterNumber, title: chapterTitle(d.chapterNumber) })}
                  </span>
                  <span className="text-[var(--color-text-muted)]">
                    {d.activeLine
                      ? t('reference.activeLine', { name: d.activeLine })
                      : t('reference.activeLineNone')}
                    {d.intimate ? ` · ${t('reference.intimate')}` : ''}
                  </span>
                </div>
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
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
