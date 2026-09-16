import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLLMStore } from '../../stores/llm-store'
import { resolveBookSeedDir } from '../../services/book-seed-files'
import { createReferenceBookSeedWorkflow } from '../../services/workflows/reference-workflow'
import {
  BOOK_SEED_DIGEST_MODES, BOOK_SEED_INSTRUCTION_MAX,
  type BookSeedOptions, type BookSeedDigestMode,
} from '../../services/reference/book-seed-io'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import { Switch } from '../ui/Switch'
import { toast } from '../ui/Toast'

export interface BookSeedPanelInitial { instruction: string; options: BookSeedOptions; modelId: string }

interface Props {
  workId: number
  workName: string
  defaultModelId: string
  busy: boolean
  initial?: BookSeedPanelInitial | null
  onClose: () => void
}

const DEFAULT_OPTIONS: BookSeedOptions = { config: true, architecture: true, characters: true, reuseNames: false, digestMode: 'none' }

export default function BookSeedPanel({ workId, workName, defaultModelId, busy, initial, onClose }: Props) {
  const { t } = useTranslation('pages')
  const models = useLLMStore((s) => s.models)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const [instruction, setInstruction] = useState(initial?.instruction ?? '')
  const [options, setOptions] = useState<BookSeedOptions>(initial?.options ?? DEFAULT_OPTIONS)
  const [modelId, setModelId] = useState(initial?.modelId ?? defaultModelId)

  useEffect(() => {
    if (!initial) return
    setInstruction(initial.instruction)
    setOptions(initial.options)
    setModelId(initial.modelId)
  }, [initial])

  const candidates = models.filter((m) => m.purposes.includes('generation'))
  const anyOption = options.config || options.architecture || options.characters
  const canRun = !busy && instruction.trim().length > 0 && anyOption

  const run = async () => {
    if (!canRun) return
    const dir = await resolveBookSeedDir({ remember: true })
    if (!dir) { toast.warning(t('reference.bookSeed.noDir')); return }
    await startWorkflow(createReferenceBookSeedWorkflow({
      workId, workName, instruction: instruction.trim(), options, exportDir: dir, modelId: modelId || undefined,
    }), false)
    onClose()
  }

  const row = (key: 'config' | 'architecture' | 'characters') => (
    <label key={key} className="flex items-center justify-between text-xs">
      <span>{t(`reference.bookSeed.opt.${key}`)}</span>
      <Switch
        checked={options[key]}
        onCheckedChange={(v) => setOptions((o) => ({ ...o, [key]: v }))}
        aria-label={t(`reference.bookSeed.opt.${key}`)}
      />
    </label>
  )

  return (
    <aside className="w-[35%] min-w-[260px] max-w-[440px] h-full flex flex-col border-l border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-2 px-3 h-8 border-b border-[var(--color-border)] flex-shrink-0">
        <h3 className="text-xs font-medium truncate">{t('reference.bookSeed.title')}</h3>
        <button
          type="button"
          className="icon-btn"
          style={{ width: 20, height: 20 }}
          title={t('reference.refine.close')}
          aria-label={t('reference.refine.close')}
          onClick={onClose}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col gap-3 px-3 py-3 overflow-y-auto">
        <p className="text-xs text-[var(--color-text-muted)]">{t('reference.bookSeed.hint')}</p>
        <Textarea
          className="min-h-[160px]"
          placeholder={t('reference.bookSeed.placeholder')}
          maxLength={BOOK_SEED_INSTRUCTION_MAX}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <p className="text-[0.6rem] text-right text-[var(--color-text-muted)] -mt-2">
          {instruction.length} / {BOOK_SEED_INSTRUCTION_MAX}
        </p>
        <div className="space-y-1.5">
          {(['config', 'architecture', 'characters'] as const).map(row)}
        </div>
        <div className="pt-2 border-t border-[var(--color-border)] space-y-1">
          <label className="flex items-center justify-between text-xs">
            <span>{t('reference.bookSeed.reuseNames')}</span>
            <Switch
              checked={options.reuseNames}
              onCheckedChange={(v) => setOptions((o) => ({ ...o, reuseNames: v }))}
              aria-label={t('reference.bookSeed.reuseNames')}
            />
          </label>
          <p className="text-[0.65rem] text-[var(--color-text-muted)]">
            {options.reuseNames ? t('reference.bookSeed.reuseNamesOn') : t('reference.bookSeed.reuseNamesOff')}
          </p>
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-1.5 text-xs">
            <span className="flex-shrink-0">{t('reference.bookSeed.digestMode.label')}</span>
            <NativeSelect
              className="flex-1"
              value={options.digestMode}
              onChange={(e) => setOptions((o) => ({ ...o, digestMode: e.target.value as BookSeedDigestMode }))}
            >
              {BOOK_SEED_DIGEST_MODES.map((m) => (
                <option key={m} value={m}>{t(`reference.bookSeed.digestMode.${m}`)}</option>
              ))}
            </NativeSelect>
          </label>
          <p className="text-[0.65rem] text-[var(--color-text-muted)]">
            {t(`reference.bookSeed.digestMode.${options.digestMode}Hint`)}
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          <span className="flex-shrink-0">{t('reference.header.outlineModel')}</span>
          <NativeSelect className="flex-1" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">{t('reference.header.defaultModel')}</option>
            {candidates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            {modelId && !candidates.some((m) => m.id === modelId) && <option value={modelId}>{modelId}</option>}
          </NativeSelect>
        </label>
        <Button size="sm" disabled={!canRun} onClick={() => void run()}>
          {t('reference.bookSeed.run')}
        </Button>
      </div>
    </aside>
  )
}
