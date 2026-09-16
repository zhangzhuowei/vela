import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  RefWorkData, RefDigestData, RefLineData, RefStageData, RefOutlineData, RefRevisionData,
} from '../../../electron/repositories/reference-repository'
import type { RefRefineScope, RefRerunScope } from '../../services/workflows/commands/reference-analysis.command'
import { buildLineMatrix } from '../../services/reference/line-matrix'
import { ipc } from '../../services/ipc-client'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { toast } from '../ui/Toast'
import MarkdownContent from '../ui/MarkdownContent'
import CollapseTitle from './CollapseTitle'
import LineMatrix from './LineMatrix'

interface Props {
  work: RefWorkData
  digests: RefDigestData[]
  lines: RefLineData[]
  stages: RefStageData[]
  outlineL2: RefOutlineData | null
  outlineL3: RefOutlineData | null
  revisions: RefRevisionData[]
  busy: boolean
  okCount: number
  isOpen: (key: string, defaultOpen?: boolean) => boolean
  toggle: (key: string, defaultOpen?: boolean) => void
  chapterTitle: (n: number) => string
  onRefine: (scope: RefRefineScope, label: string) => void
  onRerun: (scope: RefRerunScope, label: string) => void
  /** 人物线矩阵点格子：切到逐章摘要并打开该章微调 */
  onOpenDigest: (chapter: number) => void
  reloadSelected: () => Promise<void>
}

/** 大纲页签：L2 / L3 / 阶段轴 / 人物线轴 / 修订记录 */
export default function OutlineTab({
  work, digests, lines, stages, outlineL2, outlineL3, revisions, busy, okCount,
  isOpen, toggle, chapterTitle, onRefine, onRerun, onOpenDigest, reloadSelected,
}: Props) {
  const { t } = useTranslation('pages')
  const matrix = useMemo(() => buildLineMatrix(digests, lines), [digests, lines])
  const collapseLabel = t('reference.outline.collapse')
  const expandLabel = t('reference.outline.expand')

  const rollback = async (rev: RefRevisionData) => {
    if (!rev.before || rev.before === '{}') return
    try {
      if (rev.scope === 'L2' || rev.scope === 'L3') {
        await ipc.invoke('db:ref-outline-upsert', { workId: rev.workId, level: rev.scope, body: rev.before, force: true })
      } else if (rev.scope === 'stage') {
        await ipc.invoke('db:ref-stage-upsert', JSON.parse(rev.before))
      } else if (rev.scope === 'line') {
        const line = lines.find((l) => l.id === rev.targetId)
        if (line) await ipc.invoke('db:ref-line-upsert', { ...line, arcSummary: rev.before })
      } else {
        await ipc.invoke('db:ref-digest-upsert', JSON.parse(rev.before))
      }
    } catch (e) {
      toast.error(t('reference.outline.rollbackFailed', { error: e instanceof Error ? e.message : String(e) }))
      return
    }
    await reloadSelected()
  }

  const chapterLabel = (n: number) => t('reference.chapterHeading', { number: n, title: chapterTitle(n) })

  const renderOutline = (level: 'L2' | 'L3', outline: RefOutlineData | null, key: string, title: string) => (
    <section>
      <div className="flex items-center justify-between mb-2">
        <CollapseTitle open={isOpen(key)} onToggle={() => toggle(key)} title={title} collapseLabel={collapseLabel} expandLabel={expandLabel} />
        <div className="flex items-center gap-2">
          {outline && (
            <Switch
              checked={outline.locked}
              onCheckedChange={(locked) => void ipc.invoke('db:ref-outline-lock', work.id, level, locked).then(() => reloadSelected())}
              aria-label={outline.locked ? t('reference.outline.unlock') : t('reference.outline.lock')}
            />
          )}
          <Button size="sm" variant="ghost" disabled={!outline} onClick={() => onRefine({ kind: level }, title)}>
            {t('reference.outline.refine')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !!outline?.locked}
            title={t('reference.outline.rerunHint')}
            onClick={() => onRerun({ kind: level }, title)}
          >
            {t('reference.outline.rerun')}
          </Button>
        </div>
      </div>
      {isOpen(key) && (outline?.body
        ? <div className="text-xs"><MarkdownContent content={outline.body} /></div>
        : <p className="text-xs text-[var(--color-text-muted)]">{t('reference.outline.noOutline')}</p>)}
    </section>
  )

  return (
    <div className="space-y-6">
      {okCount === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">{t('reference.outline.needDigests')}</p>
      )}
      {okCount > 0 && lines.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">{t('reference.outline.needLines')}</p>
      )}

      {renderOutline('L2', outlineL2, 'l2', t('reference.outline.l2'))}
      {renderOutline('L3', outlineL3, 'l3', t('reference.outline.l3'))}

      <section>
        <div className="mb-2">
          <CollapseTitle open={isOpen('stages')} onToggle={() => toggle('stages')} title={t('reference.outline.stages')} collapseLabel={collapseLabel} expandLabel={expandLabel} />
        </div>
        {isOpen('stages') && (stages.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">{t('reference.outline.noOutline')}</p>
        ) : (
          <ul className="space-y-2">
            {stages.map((s) => {
              const open = isOpen(`stage-${s.id}`, false)
              const inRange = digests.filter((d) => d.chapterNumber >= s.fromChapter && d.chapterNumber <= s.toChapter)
              return (
                <li key={s.id} className="rounded-lg px-3 py-2 border border-[var(--color-border)] text-xs space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <CollapseTitle
                      open={open}
                      onToggle={() => toggle(`stage-${s.id}`, false)}
                      title={`${s.seq} · ${s.title} · ${s.fromChapter}–${s.toChapter}`}
                      collapseLabel={collapseLabel}
                      expandLabel={expandLabel}
                    />
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Switch
                        checked={s.locked}
                        onCheckedChange={(locked) => void ipc.invoke('db:ref-stage-upsert', { ...s, locked }).then(() => reloadSelected())}
                        aria-label={s.locked ? t('reference.outline.unlock') : t('reference.outline.lock')}
                      />
                      <Button size="sm" variant="ghost" onClick={() => onRefine({ kind: 'stage', stageId: s.id }, s.title)}>
                        {t('reference.outline.refine')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || s.locked}
                        title={t('reference.outline.rerunHint')}
                        onClick={() => onRerun({ kind: 'stage', stageId: s.id }, s.title)}
                      >
                        {t('reference.outline.rerun')}
                      </Button>
                    </div>
                  </div>
                  {open && (
                    <>
                      {s.goal && <p className="text-[var(--color-text-secondary)]">{s.goal}</p>}
                      {s.antagonist && <p className="text-[var(--color-text-muted)]">{t('reference.outline.stageAntagonist', { text: s.antagonist })}</p>}
                      {s.entryHook && <p className="text-[var(--color-text-muted)]">{t('reference.outline.stageEntry', { text: s.entryHook })}</p>}
                      {s.exitPeak && <p className="text-[var(--color-text-muted)]">{t('reference.outline.stageExit', { text: s.exitPeak })}</p>}
                      {inRange.map((d) => (
                        <button
                          key={d.chapterNumber}
                          type="button"
                          className="block w-full text-left pl-4 py-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
                          onClick={() => onRefine({ kind: 'digest', chapterNumber: d.chapterNumber }, chapterLabel(d.chapterNumber))}
                        >
                          {chapterLabel(d.chapterNumber)}
                          {d.summary ? ` · ${d.summary.slice(0, 80)}` : ''}
                        </button>
                      ))}
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        ))}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <CollapseTitle open={isOpen('lines')} onToggle={() => toggle('lines')} title={t('reference.outline.lines')} collapseLabel={collapseLabel} expandLabel={expandLabel} />
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || lines.length === 0 || lines.every((l) => l.locked)}
            title={
              busy ? t('reference.outline.rerunBusy')
                : lines.length === 0 ? t('reference.outline.needLines')
                  : lines.every((l) => l.locked) ? t('reference.outline.rerunAllLocked')
                    : t('reference.outline.rerunLinesHint')
            }
            onClick={() => onRerun({ kind: 'lines' }, t('reference.outline.lines'))}
          >
            {t('reference.outline.rerun')}
          </Button>
        </div>
        {isOpen('lines') && (lines.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">{t('reference.outline.needLines')}</p>
        ) : (
          <>
            <LineMatrix matrix={matrix} lines={lines} stages={stages} onCellClick={onOpenDigest} />
            <ul className="space-y-2 mt-3">
              {lines.map((l) => {
                const open = isOpen(`line-${l.id}`, false)
                return (
                  <li key={l.id} className="rounded-lg px-3 py-2 border border-[var(--color-border)] text-xs">
                    <div className="flex items-center justify-between mb-1">
                      <CollapseTitle open={open} onToggle={() => toggle(`line-${l.id}`, false)} title={l.name} collapseLabel={collapseLabel} expandLabel={expandLabel} />
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => onRefine({ kind: 'line', lineId: l.id }, l.name)}>
                          {t('reference.outline.refine')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || l.locked}
                          title={t('reference.outline.rerunHint')}
                          onClick={() => onRerun({ kind: 'line', lineId: l.id }, l.name)}
                        >
                          {t('reference.outline.rerun')}
                        </Button>
                      </div>
                    </div>
                    {open && (l.arcSummary
                      ? <div className="text-xs"><MarkdownContent content={l.arcSummary} /></div>
                      : <p className="text-[var(--color-text-muted)]">{t('reference.outline.noOutline')}</p>)}
                  </li>
                )
              })}
            </ul>
          </>
        ))}
      </section>

      <section>
        <div className="mb-2">
          <CollapseTitle open={isOpen('revisions', false)} onToggle={() => toggle('revisions', false)} title={t('reference.outline.revisions')} collapseLabel={collapseLabel} expandLabel={expandLabel} />
        </div>
        {isOpen('revisions', false) && (revisions.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">{t('reference.outline.noOutline')}</p>
        ) : (
          <ul className="space-y-1">
            {revisions.slice(0, 20).map((rev) => (
              <li key={rev.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-[var(--color-text-muted)]">
                  {rev.scope} · {rev.instruction.slice(0, 40)}
                </span>
                <Button size="sm" variant="ghost" disabled={!rev.before || rev.before === '{}'} onClick={() => void rollback(rev)}>
                  {t('reference.outline.rollback')}
                </Button>
              </li>
            ))}
          </ul>
        ))}
      </section>
    </div>
  )
}
