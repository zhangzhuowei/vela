import { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight, GitBranch, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BranchData } from '../../../../electron/repositories/branch-repository'
import type { DraftMeta } from '../../../stores/draft-store'
import { useBranchStore } from '../../../stores/branch-store'
import { BRANCH_BASE } from '../../../shared/chapter-addressing'
import { toast } from '../../ui/Toast'
import { confirm } from '../../ui/Confirm'
import { Button } from '../../ui/Button'
import DraftBoxGroup from './DraftBoxGroup'
import ManuscriptGroup from './ManuscriptGroup'
import BranchCreateDialog from '../../dialogs/BranchCreateDialog'

function draftsInRange(draftsByChapter: Record<number, DraftMeta[]>, from: number, to: number): Record<number, DraftMeta[]> {
  return Object.fromEntries(
    Object.entries(draftsByChapter).filter(([n]) => {
      const num = Number(n)
      return num >= from && num <= to
    }),
  )
}

export default function BranchGroup({
  branches,
  draftsByChapter,
  finalized,
  projectPath,
}: {
  branches: BranchData[]
  draftsByChapter: Record<number, DraftMeta[]>
  finalized: DraftMeta[]
  projectPath: string
}) {
  const { t } = useTranslation('panels')
  const remove = useBranchStore((s) => s.remove)
  const [open, setOpen] = useState(true)
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set(branches.map((b) => b.id)))
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<BranchData | null>(null)

  useEffect(() => {
    setOpenIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const b of branches) {
        if (!next.has(b.id)) {
          next.add(b.id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [branches])

  const toggle = (id: number) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const subtitleOf = (b: BranchData): string => {
    if (b.anchorChapter <= 0) return t('branch.prequel')
    return b.kind === 'if'
      ? t('branch.forkAt', { chapter: b.anchorChapter })
      : t('branch.anchorAfter', { chapter: b.anchorChapter })
  }

  const handleDelete = async (b: BranchData) => {
    const ok = await confirm(t('branch.delete'), { title: t('branch.delete'), confirmText: t('branch.delete'), danger: true })
    if (!ok) return
    const res = await remove(b.id)
    if (!res.success && res.error === 'BRANCH_NOT_EMPTY') toast.warning(t('branch.notEmpty'))
    else if (!res.success) toast.error(res.error || t('branch.notEmpty'))
  }

  return (
    <div>
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen((v) => !v)}
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <GitBranch size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium flex-1 min-w-0 truncate" style={{ color: 'var(--color-text)' }}>
          {t('branch.groupTitle')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          title={t('branch.create')}
          onClick={(e) => {
            e.stopPropagation()
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus size={12} />
        </Button>
      </div>

      {open && (
        <div>
          {branches.length === 0 && (
            <div className="text-xs py-1" style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}>
              {t('branch.create')}
            </div>
          )}
          {branches.map((b) => {
            const from = b.id * BRANCH_BASE + 1
            const to = (b.id + 1) * BRANCH_BASE - 1
            const lineDrafts = draftsInRange(draftsByChapter, from, to)
            const lineFinalized = finalized.filter((d) => d.chapterNumber >= from && d.chapterNumber <= to)
            const files = lineFinalized
              .sort((a, c) => a.chapterNumber - c.chapterNumber)
              .map((d) => ({
                path: `vela://manuscript/${d.id}`,
                name: `chapter_${d.chapterNumber}.md`,
                isDir: false,
              }))
            const lineOpen = openIds.has(b.id)
            const kindLabel = b.kind === 'if' ? `IF·${b.name}` : `番外·${b.name}`
            return (
              <div key={b.id}>
                <div
                  className="tree-item gap-1.5 cursor-pointer select-none"
                  style={{ paddingLeft: 22 }}
                  onClick={() => toggle(b.id)}
                  title={`${kindLabel}（${subtitleOf(b)}）`}
                >
                  {lineOpen
                    ? <ChevronDown size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                    : <ChevronRight size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                  }
                  <span className="text-sm flex-1 min-w-0 truncate" style={{ color: 'var(--color-text-secondary)' }}>
                    {kindLabel}（{subtitleOf(b)}）
                  </span>
                  <button
                    className="opacity-60 hover:opacity-100"
                    title={t('branch.edit')}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(b)
                      setDialogOpen(true)
                    }}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    className="opacity-60 hover:opacity-100"
                    title={t('branch.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(b)
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                {lineOpen && (
                  <div>
                    <DraftBoxGroup draftsByChapter={lineDrafts} branches={branches} />
                    <ManuscriptGroup files={files} projectPath={projectPath} branches={branches} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <BranchCreateDialog
        isOpen={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false)
          setEditing(null)
        }}
      />
    </div>
  )
}
