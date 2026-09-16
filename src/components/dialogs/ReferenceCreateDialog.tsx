import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, FolderOpen, BookOpen, Zap, Clock, AlertTriangle } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useReferenceStore } from '../../stores/reference-store'
import { useLLMStore } from '../../stores/llm-store'
import { ipc } from '../../services/ipc-client'
import { createReferenceDigestWorkflow } from '../../services/workflows/reference-workflow'
import { estimateReferenceCost } from '../../services/reference/cost-estimate'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { toast } from '../ui/Toast'

interface ReferenceCreateDialogProps {
  open: boolean
  onClose: () => void
}

export default function ReferenceCreateDialog({ open, onClose }: ReferenceCreateDialogProps) {
  const { t } = useTranslation('dialogs')
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const models = useLLMStore((s) => s.models)

  const [name, setName] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [chapters, setChapters] = useState<Array<{ number: number; title: string; content: string; wordCount: number }>>([])
  const [splitting, setSplitting] = useState(false)
  const [splitDone, setSplitDone] = useState(false)
  const [splitError, setSplitError] = useState('')
  const [rangeMode, setRangeMode] = useState<'sample' | 'all'>('sample')
  const [sampleTo, setSampleTo] = useState(200)
  const [digestModelId, setDigestModelId] = useState('')
  const [outlineModelId, setOutlineModelId] = useState('')
  const [starting, setStarting] = useState(false)

  const digestCandidates = models.filter((m) => m.purposes.includes('summary') || m.purposes.includes('generation'))
  const outlineCandidates = models.filter((m) => m.purposes.includes('generation'))

  const range = rangeMode === 'all'
    ? { from: 1, to: chapters.length }
    : { from: 1, to: Math.min(sampleTo, chapters.length) }
  const estimate = chapters.length > 0 ? estimateReferenceCost(chapters, range) : null

  const reset = () => {
    setName('')
    setFiles([])
    setChapters([])
    setSplitting(false)
    setSplitDone(false)
    setSplitError('')
    setRangeMode('sample')
    setSampleTo(200)
    setDigestModelId('')
    setOutlineModelId('')
    setStarting(false)
  }

  const handleClose = () => {
    if (starting || splitting) return
    reset()
    onClose()
  }

  const handleSelectFiles = useCallback(async () => {
    const selected = await ipc.invoke('dialog:select-novel-files')
    if (!selected || selected.length === 0) return

    setFiles(selected)
    setSplitDone(false)
    setSplitError('')
    setChapters([])

    if (!name.trim()) {
      const firstFile = selected[0]
      const baseName = firstFile.split(/[/\\]/).pop()?.replace(/\.(txt|md|text)$/i, '') || ''
      if (baseName) setName(baseName)
    }

    setSplitting(true)
    try {
      const result = await ipc.invoke('import:split-chapters', selected)
      if (result.success) {
        setChapters(result.chapters)
        setSplitDone(true)
      } else {
        setSplitError(result.error || t('referenceCreate.splitFailed'))
      }
    } catch (e) {
      setSplitError(String(e))
    } finally {
      setSplitting(false)
    }
  }, [name, t])

  const handleStart = async () => {
    if (!name.trim() || chapters.length === 0) return
    setStarting(true)
    try {
      const workRes = await ipc.invoke('db:ref-work-upsert', {
        name: name.trim(),
        sourceFiles: files,
        totalChapters: chapters.length,
        totalWords: chapters.reduce((s, c) => s + c.wordCount, 0),
        analyzedFrom: 0,
        analyzedTo: 0,
        digestModelId,
        outlineModelId,
        status: 'idle',
      })
      if (!workRes.success || !workRes.data) {
        toast.error(workRes.error || t('referenceCreate.startFailed'))
        return
      }
      const workId = workRes.data
      const rep = await ipc.invoke('db:ref-chapter-replace', workId, chapters)
      if (!rep.success) {
        toast.error(rep.error || t('referenceCreate.startFailed'))
        return
      }
      await useReferenceStore.getState().loadWorks()
      await useReferenceStore.getState().selectWork(workId)
      await startWorkflow(createReferenceDigestWorkflow({
        workId,
        workName: name.trim(),
        from: range.from,
        to: Math.max(range.from, range.to),
      }), false)
      reset()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const selectClass = 'w-full h-8 px-2 rounded-lg text-xs bg-[var(--color-input)] border border-[var(--color-border)] text-[var(--color-text)]'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp size={18} className="text-[var(--color-accent)]" />
            {t('referenceCreate.title')}
          </DialogTitle>
          <DialogDescription>{t('referenceCreate.description')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <div>
            <Label>{t('referenceCreate.selectFile')}</Label>
            <div className="flex gap-2">
              <div
                className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-xs truncate"
                style={{
                  backgroundColor: 'var(--color-input)',
                  border: '1px solid var(--color-border)',
                  color: files.length > 0 ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                <BookOpen size={14} style={{ flexShrink: 0 }} />
                {files.length > 0
                  ? t('referenceCreate.filesSelected', { count: files.length })
                  : t('referenceCreate.supportedFormats')}
              </div>
              <Button variant="outline" onClick={() => void handleSelectFiles()} disabled={splitting || starting}>
                <FolderOpen size={14} />
                {t('referenceCreate.select')}
              </Button>
            </div>
          </div>

          {splitting && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}>
              <div className="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
              {t('referenceCreate.analyzing')}
            </div>
          )}

          {splitError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'rgba(220, 38, 38, 0.08)', color: 'var(--color-danger, #dc2626)' }}>
              <AlertTriangle size={14} />
              {splitError}
            </div>
          )}

          <div>
            <Label>{t('referenceCreate.name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('referenceCreate.namePlaceholder')}
            />
          </div>

          {splitDone && chapters.length > 0 && (
            <>
              <div>
                <Label>{t('referenceCreate.range')}</Label>
                <div className="flex items-center gap-3 mt-1 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="ref-range"
                      checked={rangeMode === 'sample'}
                      onChange={() => setRangeMode('sample')}
                    />
                    {t('referenceCreate.sampleTo')}
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={chapters.length}
                    value={sampleTo}
                    disabled={rangeMode !== 'sample'}
                    onChange={(e) => setSampleTo(Math.max(1, Number(e.target.value) || 1))}
                    className="w-20 h-7"
                  />
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="ref-range"
                      checked={rangeMode === 'all'}
                      onChange={() => setRangeMode('all')}
                    />
                    {t('referenceCreate.all')}
                  </label>
                  <span className="text-[var(--color-text-muted)]">
                    {t('referenceCreate.totalChapters', { count: chapters.length })}
                  </span>
                </div>
                {rangeMode === 'sample' && (
                  <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">{t('referenceCreate.sampleHint')}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t('referenceCreate.digestModel')}</Label>
                  <select className={selectClass} value={digestModelId} onChange={(e) => setDigestModelId(e.target.value)}>
                    <option value="">{t('referenceCreate.defaultModel')}</option>
                    {digestCandidates.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>{t('referenceCreate.outlineModel')}</Label>
                  <select className={selectClass} value={outlineModelId} onChange={(e) => setOutlineModelId(e.target.value)}>
                    <option value="">{t('referenceCreate.defaultModel')}</option>
                    {outlineCandidates.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}

          {estimate && (
            <div className="rounded-lg px-3 py-2.5 space-y-1.5"
              style={{
                backgroundColor: 'rgba(107, 164, 220, 0.06)',
                border: '1px solid rgba(107, 164, 220, 0.15)',
              }}>
              <div className="flex items-center gap-1.5">
                <Zap size={13} style={{ color: 'var(--color-accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  {t('referenceCreate.estimate', {
                    calls: estimate.digestCalls,
                    minutes: estimate.estimatedMinutes,
                    tokens: estimate.estimatedTokens.toLocaleString(),
                  })}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                <Clock size={11} />
                {t('referenceCreate.sampleHint')}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={starting}>{t('cancel', { ns: 'common' })}</Button>
          <Button
            onClick={() => void handleStart()}
            disabled={starting || splitting || !name.trim() || chapters.length === 0 || range.to < 1}
          >
            <FileUp size={14} />
            {starting ? t('referenceCreate.starting') : t('referenceCreate.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
