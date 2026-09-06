import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, FolderOpen } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { defaultCloneName, parentDir } from '../../services/project-seed'
import { ipc } from '../../services/ipc-client'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'

interface CopyProjectDialogProps {
  open: boolean
  onClose: () => void
}

/** 复制当前书的小说配置 + 故事架构为新项目 */
export default function CopyProjectDialog({ open, onClose }: CopyProjectDialogProps) {
  const { t } = useTranslation('dialogs')
  const currentProject = useProjectStore((s) => s.currentProject)
  const cloneProjectSeed = useProjectStore((s) => s.cloneProjectSeed)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open || !currentProject) return
    setName(defaultCloneName(currentProject.name))
    setPath(parentDir(currentProject.path))
  }, [open, currentProject])

  const handleSelectFolder = async () => {
    const selected = await ipc.invoke('dialog:select-folder')
    if (selected) setPath(selected)
  }

  const handleCreate = async () => {
    if (!currentProject || !name.trim() || !path.trim()) return
    setCreating(true)
    const success = await cloneProjectSeed({
      sourcePath: currentProject.path,
      destParent: path.trim(),
      name: name.trim(),
    })
    setCreating(false)
    if (success) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy size={18} className="text-[var(--color-accent)]" />
            {t('copyProject.title')}
          </DialogTitle>
          <DialogDescription>{t('copyProject.description')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          <div>
            <Label>{t('copyProject.nameLabel')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('copyProject.namePlaceholder')}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            />
          </div>
          <div>
            <Label>{t('copyProject.pathLabel')}</Label>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t('copyProject.pathPlaceholder')}
                className="flex-1"
              />
              <Button variant="outline" onClick={() => void handleSelectFolder()}>
                <FolderOpen size={14} />
                {t('copyProject.selectFolder')}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('copyProject.cancel')}</Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={creating || !currentProject || !name.trim() || !path.trim()}
          >
            <Copy size={14} />
            {creating ? t('copyProject.creating') : t('copyProject.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
