import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useModRevision } from '../../hooks/use-mod-revision'
import { DIALOGUE_FORMAT_PIN_MARKER } from '../../services/dialogue/dialogue-prompts'
import { annotateRequestMessages } from '../../services/llm-request-inspect'
import { getActiveModLayers } from '../../services/mods'
import { useLLMStore } from '../../stores/llm-store'

function slotColor(slot: string): string {
  if (slot === 'post_history') return 'var(--color-warning)'
  if (slot === 'system') return 'var(--color-accent)'
  return 'var(--color-text-muted)'
}

function RequestMonitor({
  chapterNumber,
  sceneId,
}: {
  chapterNumber?: number
  sceneId?: number
}) {
  const { t } = useTranslation('editors')
  useModRevision()
  const lastTraces = useLLMStore((s) => s.lastTraces)
  const models = useLLMStore((s) => s.models)
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const newestId = lastTraces[0]?.id
  const trace = lastTraces.find((item) => item.id === selectedId) ?? lastTraces[0]
  const layers = getActiveModLayers(
    chapterNumber != null ? { chapterNumber, sceneId } : undefined
  )
  const pins = [layers.postHistory, DIALOGUE_FORMAT_PIN_MARKER]
  const rows = trace ? annotateRequestMessages(trace.messages, pins) : []
  const pinned = rows.some((r) => r.slot === 'post_history')
  const [openIds, setOpenIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (newestId) setSelectedId(newestId)
  }, [newestId])

  useEffect(() => {
    setOpenIds(new Set())
  }, [trace?.id])

  if (!trace) {
    return (
      <div className="px-3 py-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('dialogue.requestMonitorEmpty')}
      </div>
    )
  }

  const modelName =
    trace.modelId === 'preview'
      ? t('dialogue.requestTracePreview')
      : (models.find((m) => m.id === trace.modelId)?.name ?? trace.modelId)
  const layerNames = layers.parts
    .map((p) =>
      t('dialogue.requestLayerItem', {
        name: p.name,
        slot: p.inject === 'system' ? t('dialogue.requestSlotSystem') : t('dialogue.requestSlotPostHistory'),
      })
    )
    .join(t('dialogue.requestLayerJoin'))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {lastTraces.length > 1 && (
        <div className="flex flex-shrink-0 flex-wrap gap-1 px-3 pt-2">
          {lastTraces.map((item) => {
            const label =
              item.modelId === 'preview'
                ? t('dialogue.requestTracePreview')
                : (models.find((m) => m.id === item.modelId)?.name ?? item.modelId)
            const active = item.id === trace.id
            return (
              <button
                key={item.id}
                type="button"
                className="rounded-full px-2 py-0.5 text-[0.62rem]"
                style={{
                  border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  backgroundColor: 'var(--color-hover)',
                }}
                onClick={() => setSelectedId(item.id)}
              >
                {t('dialogue.requestTraceItem', {
                  time: new Date(item.at).toLocaleTimeString(),
                  model: label,
                  n: item.messages.length,
                })}
              </button>
            )
          })}
        </div>
      )}
      <div
        className="flex flex-shrink-0 flex-wrap items-center gap-2 px-3 pt-2 text-[0.68rem]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <span>{t('dialogue.requestMonitorTitle')}</span>
        <span>{modelName}</span>
        <span>{t('dialogue.requestMsgCount', { n: rows.length })}</span>
        <span style={{ color: pinned ? 'var(--color-warning)' : undefined }}>
          {pinned ? t('dialogue.requestPinned') : t('dialogue.requestNotPinned')}
        </span>
      </div>
      <div className="flex-shrink-0 px-3 pb-1 text-[0.68rem]" style={{ color: 'var(--color-text-secondary)' }}>
        {layerNames
          ? t('dialogue.requestLayers', { names: layerNames })
          : t('dialogue.requestActiveModsNone')}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 pb-2">
        {rows.map((row) => {
          const open = openIds.has(row.index)
          const slotLabel =
            row.slot === 'post_history'
              ? t('dialogue.requestSlotPostHistory')
              : row.slot === 'system'
                ? t('dialogue.requestSlotSystem')
                : t('dialogue.requestSlotHistory')
          return (
            <div
              key={row.index}
              className="rounded-lg"
              style={{
                border: `1px solid ${row.slot === 'post_history' ? 'var(--color-warning)' : 'var(--color-border)'}`,
                backgroundColor: 'var(--color-sidebar)',
              }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[0.68rem]"
                onClick={() =>
                  setOpenIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(row.index)) next.delete(row.index)
                    else next.add(row.index)
                    return next
                  })
                }
              >
                <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                  #{row.index} {row.role}
                </span>
                <span style={{ color: slotColor(row.slot) }}>{slotLabel}</span>
                <span className="ml-auto" style={{ color: 'var(--color-text-muted)' }}>
                  {t('dialogue.wordCount', { n: row.chars })}
                </span>
              </button>
              {open && (
                <pre
                  className="max-h-36 overflow-auto whitespace-pre-wrap px-2.5 pb-2 text-[0.7rem] leading-5"
                  style={{ color: 'var(--color-text)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                >
                  {row.content}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default memo(RequestMonitor)
