import { useEffect, useState } from 'react'
import { Library, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../stores/project-store'
import { useReferenceStore } from '../../stores/reference-store'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { confirm } from '../ui/Confirm'
import ReferenceCreateDialog from '../dialogs/ReferenceCreateDialog'
import { cn } from '../../lib/utils'

export default function ReferencePanel() {
  const { t } = useTranslation('panels')
  const currentProject = useProjectStore((s) => s.currentProject)
  const { works, selectedWorkId, loadWorks, selectWork, deleteWork } = useReferenceStore()
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    void useReferenceStore.getState().selectWork(null)
    if (!currentProject) return
    void loadWorks()
  }, [currentProject, loadWorks])

  if (!currentProject) {
    return (
      <EmptyState
        icon={<Library size={36} />}
        message={t('reference.openProjectFirst')}
        className="pb-[15vh]"
        opacity={0.4}
      />
    )
  }

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="flex items-center justify-between px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-1.5">
          <Library size={13} />
          {t('reference.title')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={t('reference.create')}
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={11} />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {works.length === 0 && (
          <p className="px-3 py-4 text-xs text-[var(--color-text-muted)]">{t('reference.empty')}</p>
        )}
        {works.map((w) => (
          <div
            key={w.id}
            className={cn(
              'group px-3 py-2 text-xs cursor-pointer flex items-start gap-2',
              selectedWorkId === w.id ? 'bg-[var(--color-hover)]' : 'hover:bg-[var(--color-hover)]/50',
            )}
            onClick={() => void selectWork(selectedWorkId === w.id ? null : w.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="truncate">{w.name}</div>
              <div className="text-[var(--color-text-muted)]">
                {t('reference.meta', {
                  chapters: w.totalChapters,
                  analyzed: w.analyzedTo,
                  status: t(`reference.status.${w.status}`),
                })}
              </div>
            </div>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger,#dc2626)]"
              title={t('reference.delete')}
              onClick={async (e) => {
                e.stopPropagation()
                const ok = await confirm(t('reference.deleteConfirm', { name: w.name }), { danger: true })
                if (ok) await deleteWork(w.id)
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <ReferenceCreateDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}
