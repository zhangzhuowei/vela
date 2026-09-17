import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Save, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RefExportData } from '../../../electron/repositories/reference-repository'
import { ipc } from '../../services/ipc-client'
import { resolveBookSeedDir, writeBookSeedFiles } from '../../services/book-seed-files'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import { cn } from '../../lib/utils'
import { formatSqliteUtc } from '../../utils/time'
import type { BookSeedPanelInitial } from './BookSeedPanel'

interface Props {
  workName: string
  /** 列表项只有元数据（大字段为空串），完整内容按 id 再取 */
  records: RefExportData[]
  onDelete: (id: number) => Promise<void>
  onReuse: (initial: BookSeedPanelInitial) => void
}

/** 重新保存：目录设置为空时只弹框不回写（一次性换目录很常见） */
async function resaveRecord(rec: RefExportData, workName: string): Promise<string[]> {
  const dir = await resolveBookSeedDir({ remember: false })
  if (!dir) return []
  return writeBookSeedFiles({
    dir, workName, generatedAt: new Date().toISOString(),
    bookJson: rec.bookJson, charactersJson: rec.charactersJson,
  })
}

export default function ExportRecordsTab({ workName, records, onDelete, onReuse }: Props) {
  const { t } = useTranslation('pages')
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [details, setDetails] = useState<Record<number, RefExportData>>({})
  const [loadingId, setLoadingId] = useState<number | null>(null)

  if (records.length === 0) {
    return <p className="text-xs text-[var(--color-text-muted)]">{t('reference.exports.empty')}</p>
  }

  /** 取完整记录（带大字段），本页签内缓存 */
  const loadDetail = async (id: number): Promise<RefExportData | null> => {
    if (details[id]) return details[id]
    setLoadingId(id)
    try {
      const full = await ipc.invoke('db:ref-export-get', id)
      if (full) setDetails((d) => ({ ...d, [id]: full }))
      else toast.error(t('reference.exports.loadFailed'))
      return full
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setLoadingId(null)
    }
  }

  const toggleOpen = async (rec: RefExportData) => {
    const next = !open[rec.id]
    setOpen((o) => ({ ...o, [rec.id]: next }))
    if (next) await loadDetail(rec.id)
  }

  const optionSummary = (rec: RefExportData) => {
    const parts = (['config', 'architecture', 'characters'] as const)
      .filter((k) => rec.options[k])
      .map((k) => t(`reference.bookSeed.opt.${k}`))
    if (rec.options.reuseNames) parts.push(t('reference.bookSeed.reuseNames'))
    if (rec.options.digestMode !== 'none') parts.push(t(`reference.bookSeed.digestMode.${rec.options.digestMode}`))
    return parts.join(' · ')
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('reference.exports.copied'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const resave = async (rec: RefExportData) => {
    const full = await loadDetail(rec.id)
    if (!full) return
    try {
      const paths = await resaveRecord(full, workName)
      if (paths.length) toast.success(t('reference.exports.resaved', { count: paths.length }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (rec: RefExportData) => {
    if (!(await confirm(t('reference.exports.deleteConfirm'), { danger: true }))) return
    setDetails((d) => { const { [rec.id]: _drop, ...rest } = d; return rest })
    await onDelete(rec.id)
  }

  const blocks = (full: RefExportData): Array<[string, string]> => [
    ['bookJson', full.bookJson],
    ['charactersJson', full.charactersJson],
    ['rawOutput', full.status === 'failed' ? full.rawOutput : ''],
  ]

  return (
    <div className="space-y-2">
      {records.map((rec) => {
        const isOpen = !!open[rec.id]
        const full = details[rec.id]
        return (
          <div
            key={rec.id}
            className={cn('rounded-lg px-3 py-2 border border-[var(--color-border)]', rec.status === 'failed' && 'opacity-80')}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                className="flex items-center gap-1 min-w-0 text-left"
                aria-expanded={isOpen}
                onClick={() => void toggleOpen(rec)}
              >
                {isOpen ? <ChevronDown size={12} className="flex-shrink-0" /> : <ChevronRight size={12} className="flex-shrink-0" />}
                <span className="truncate">
                  {formatSqliteUtc(rec.createdAt)} · {t(`reference.exports.status.${rec.status}`)} · {rec.modelId || t('reference.header.defaultModel')} · {optionSummary(rec)}
                </span>
              </button>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('reference.exports.reuse')}
                  onClick={() => onReuse({ instruction: rec.instruction, options: rec.options, modelId: rec.modelId })}
                >
                  <RotateCcw size={12} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={(!rec.hasBookJson && !rec.hasCharactersJson) || loadingId === rec.id}
                  title={t('reference.exports.resave')}
                  onClick={() => void resave(rec)}
                >
                  <Save size={12} />
                </Button>
                <Button size="sm" variant="ghost" title={t('reference.exports.delete')} onClick={() => void remove(rec)}>
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mt-1 truncate">{rec.instruction.slice(0, 60)}</p>
            {isOpen && (
              <div className="mt-2 space-y-2 text-xs">
                <section>
                  <h4 className="font-medium mb-1">{t('reference.exports.instruction')}</h4>
                  <pre className="whitespace-pre-wrap break-words text-[var(--color-text-muted)]">{rec.instruction}</pre>
                </section>
                {rec.filePaths.length > 0 && (
                  <section>
                    <h4 className="font-medium mb-1">{t('reference.exports.files')}</h4>
                    <ul className="text-[var(--color-text-muted)]">
                      {rec.filePaths.map((p) => <li key={p} className="break-all">{p}</li>)}
                    </ul>
                  </section>
                )}
                {rec.status === 'failed' && (
                  <section>
                    <h4 className="font-medium mb-1 text-[var(--color-danger,#dc2626)]">{t('reference.exports.error')}</h4>
                    <pre className="whitespace-pre-wrap break-words">{rec.error}</pre>
                  </section>
                )}
                {!full && loadingId === rec.id && (
                  <p className="text-[var(--color-text-muted)]">{t('reference.exports.loading')}</p>
                )}
                {full && blocks(full).map(([key, text]) => (
                  text ? (
                    <section key={key}>
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="font-medium">{t(`reference.exports.${key}`)}</h4>
                        <Button size="sm" variant="ghost" title={t('reference.exports.copy')} onClick={() => void copy(text)}>
                          <Copy size={12} />
                        </Button>
                      </div>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-hover)] p-2">{text}</pre>
                    </section>
                  ) : null
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
