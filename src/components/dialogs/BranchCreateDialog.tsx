import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import { useBranchStore } from '../../stores/branch-store'
import { ipc } from '../../services/ipc-client'
import { isMainChapter, type BranchKind } from '../../shared/chapter-addressing'
import type { BranchData } from '../../../electron/repositories/branch-repository'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'

interface Props {
  isOpen: boolean
  onClose: () => void
  editing?: BranchData | null
}

export default function BranchCreateDialog({ isOpen, onClose, editing }: Props) {
  const { t } = useTranslation('dialogs')
  const save = useBranchStore((s) => s.save)
  const branches = useBranchStore((s) => s.branches)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<BranchKind>('extra')
  const [anchor, setAnchor] = useState(0)
  const [premise, setPremise] = useState('')
  const [settingDiff, setSettingDiff] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [anchorLocked, setAnchorLocked] = useState(false)
  const [blueprints, setBlueprints] = useState<BlueprintData[]>([])

  useEffect(() => {
    if (!isOpen) return
    setName(editing?.name ?? '')
    setKind(editing?.kind ?? 'extra')
    setAnchor(editing?.anchorChapter ?? 0)
    setPremise(editing?.premise ?? '')
    setSettingDiff(editing?.settingDiff ?? '')
    setError('')
    setAnchorLocked(false)
    void ipc.invoke('db:blueprint-get-all').then((bps) => setBlueprints(bps || [])).catch(() => setBlueprints([]))
    if (editing?.id) {
      void ipc.invoke('db:branch-stats', editing.id).then((s) => {
        setAnchorLocked((s?.finalizedCount ?? 0) > 0)
      }).catch(() => setAnchorLocked(false))
    }
  }, [isOpen, editing])

  const maxMain = useMemo(
    () => Math.max(0, ...blueprints.filter((b) => isMainChapter(b.chapterNumber)).map((b) => b.chapterNumber)),
    [blueprints],
  )
  const anchorTitle = blueprints.find((b) => b.chapterNumber === anchor)?.title ?? ''

  const onSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('branch.name'))
      return
    }
    const n = Number(anchor)
    if (!Number.isInteger(n) || n < 0 || n > maxMain) {
      setError(t('branch.anchorHint'))
      return
    }
    setSaving(true)
    const res = await save({
      id: editing?.id,
      name: trimmed,
      kind,
      anchorKind: 'chapter',
      anchorChapter: n,
      premise: premise.trim(),
      settingDiff: settingDiff.trim(),
      sortOrder: editing?.sortOrder ?? branches.length,
    })
    setSaving(false)
    if (res.success) onClose()
    else setError(res.error ?? '')
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch size={16} className="text-[var(--color-accent)]" />
            {editing ? t('branch.editTitle') : t('branch.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('branch.anchorHint')}</DialogDescription>
        </DialogHeader>
        <div className="px-5 py-4 space-y-3">
          <div>
            <Label>{t('branch.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>{t('branch.kind')}</Label>
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as BranchKind)}>
              <option value="extra">{t('branch.kindExtra')}</option>
              <option value="if">{t('branch.kindIf')}</option>
            </NativeSelect>
          </div>
          <div>
            <Label>{t('branch.anchor')}</Label>
            <Input
              type="number"
              min={0}
              max={maxMain}
              value={anchor}
              disabled={anchorLocked}
              onChange={(e) => setAnchor(e.target.value === '' ? 0 : parseInt(e.target.value, 10))}
            />
            <div className="text-[0.7rem] mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {anchorLocked
                ? t('branch.anchorLockedHint')
                : (anchor === 0 ? t('branch.anchorPrequel') : (anchorTitle || t('branch.anchorHint')))}
            </div>
          </div>
          <div>
            <Label>{t('branch.premise')}</Label>
            <Textarea
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
              placeholder={t('branch.premisePlaceholder')}
              rows={2}
            />
          </div>
          {(kind === 'if' || settingDiff) && (
            <div>
              <Label>{t('branch.settingDiff')}</Label>
              <Textarea
                value={settingDiff}
                onChange={(e) => setSettingDiff(e.target.value)}
                placeholder={t('branch.settingDiffPlaceholder')}
                rows={2}
              />
            </div>
          )}
          {error && (
            <div className="text-xs text-red-500">{error}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('branch.cancel')}</Button>
          <Button variant="default" onClick={() => void onSave()} disabled={saving}>
            {t('branch.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
