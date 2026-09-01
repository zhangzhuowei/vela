import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { annotateRequestMessages } from '../../services/llm-request-inspect'
import { getActiveModGuidance } from '../../services/mods'
import { useLLMStore } from '../../stores/llm-store'

function slotColor(slot: string): string {
  if (slot === 'post_history') return 'var(--color-warning)'
  if (slot === 'system') return 'var(--color-accent)'
  return 'var(--color-text-muted)'
}

export default function RequestMonitor() {
  const { t } = useTranslation('editors')
  const lastTraces = useLLMStore((s) => s.lastTraces)
  const models = useLLMStore((s) => s.models)
  const trace = lastTraces[0]
  const pin = getActiveModGuidance()
  const rows = trace ? annotateRequestMessages(trace.messages, pin) : []
  const pinned = rows.some((r) => r.slot === 'post_history')
  const [openIds, setOpenIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!trace) return
    const annotated = annotateRequestMessages(trace.messages, getActiveModGuidance())
    const next = new Set<number>()
    for (const row of annotated) {
      if (row.slot === 'post_history') next.add(row.index)
    }
    if (next.size === 0 && annotated.length > 0) next.add(annotated.length - 1)
    setOpenIds(next)
  }, [trace?.id])

  if (!trace) {
    return (
      <div className="px-3 py-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('dialogue.requestMonitorEmpty')}
      </div>
    )
  }

  const modelName = models.find((m) => m.id === trace.modelId)?.name ?? trace.modelId

  return (
    <div className="max-h-64 space-y-1.5 overflow-y-auto px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        <span>{t('dialogue.requestMonitorTitle')}</span>
        <span>{modelName}</span>
        <span>{t('dialogue.requestMsgCount', { n: rows.length })}</span>
        <span style={{ color: pinned ? 'var(--color-warning)' : undefined }}>
          {pinned ? t('dialogue.requestPinned') : t('dialogue.requestNotPinned')}
        </span>
      </div>
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
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.68rem]"
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
                className="max-h-40 overflow-auto whitespace-pre-wrap px-2.5 pb-2 text-[0.7rem] leading-5"
                style={{ color: 'var(--color-text)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
              >
                {row.content}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}
