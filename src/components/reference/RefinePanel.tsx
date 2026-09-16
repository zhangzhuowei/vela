import { useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore } from '../../stores/workflow-store'
import { createReferenceRefineWorkflow } from '../../services/workflows/reference-workflow'
import type { RefRefineScope } from '../../services/workflows/commands/reference-analysis.command'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Textarea'

interface Props {
  workId: number
  workName: string
  scope: RefRefineScope
  scopeLabel: string
  onClear: () => void
}

export default function RefinePanel({ workId, workName, scope, scopeLabel, onClear }: Props) {
  const { t } = useTranslation('pages')
  const [instruction, setInstruction] = useState('')
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)

  const fill = (key: 'example1' | 'example2' | 'example3') => {
    setInstruction(t(`reference.refine.${key}`))
  }

  const run = async () => {
    if (!instruction.trim()) return
    await startWorkflow(createReferenceRefineWorkflow({
      workId, workName, scope, instruction: instruction.trim(), scopeLabel,
    }), false)
    setInstruction('')
  }

  return (
    <aside className="w-[35%] min-w-[240px] max-w-[420px] h-full flex flex-col border-l border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-2 px-3 h-8 border-b border-[var(--color-border)] flex-shrink-0">
        <h3 className="text-xs font-medium truncate">{t('reference.refine.title')}</h3>
        <button
          type="button"
          className="icon-btn"
          style={{ width: 20, height: 20 }}
          title={t('reference.refine.close')}
          aria-label={t('reference.refine.close')}
          onClick={onClear}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col px-3 py-3">
        <p className="text-xs text-[var(--color-text-muted)] mb-2">{scopeLabel}</p>
        <Textarea
          className="flex-1 min-h-[120px]"
          placeholder={t('reference.refine.placeholder')}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <Button className="mt-2" size="sm" disabled={!instruction.trim()} onClick={() => void run()}>
          {t('reference.refine.run')}
        </Button>
        <div className="mt-3 space-y-1">
          {(['example1', 'example2', 'example3'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="block w-full text-left text-[0.65rem] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              onClick={() => fill(key)}
            >
              {t(`reference.refine.${key}`)}
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
