import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useBranchStore } from '../../stores/branch-store'
import { toast } from '../ui/Toast'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import { ipc } from '../../services/ipc-client'
import { BRANCH_BASE } from '../../shared/chapter-addressing'
import type { DirectoryWorkflowParams } from '../../services/workflows/directory-workflow'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** @deprecated 内部按目标线查询；保留以免旧调用方报错 */
  existingCount?: number
  defaultBranchId?: number
  onConfirm: (params: DirectoryWorkflowParams) => void
}

/** 蓝图生成配置弹框 — 选择生成范围和模式 */
export default function DirectoryConfigDialog({ isOpen, onClose, defaultBranchId = 0, onConfirm }: Props) {
  const { t } = useTranslation('dialogs')
  const currentProject = useProjectStore(s => s.currentProject)
  const branches = useBranchStore(s => s.branches)

  const [branchId, setBranchId] = useState(0)
  const [existingCount, setExistingCount] = useState(0)

  // 范围选择
  const [rangeMode, setRangeMode] = useState<'front' | 'range' | 'full'>('front')
  // 覆盖/追加模式选择 (仅当 existingCount > 0 时有效)
  const [overwriteMode, setOverwriteMode] = useState<'append' | 'full'>('append')

  const [frontN, setFrontN] = useState<number | ''>(50)
  const [rangeStart, setRangeStart] = useState<number | ''>(1)
  const [rangeEnd, setRangeEnd] = useState<number | ''>(50)
  // 节奏指导
  const [pacingGuidance, setPacingGuidance] = useState('')

  const isBatchRunning = useWorkflowStore(s => s.isTypeRunning('batch_generate'))

  useEffect(() => {
    if (isOpen) setBranchId(defaultBranchId || 0)
  }, [isOpen, defaultBranchId])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    void (async () => {
      const n = branchId === 0
        ? await ipc.invoke('db:blueprint-count')
        : await ipc.invoke('db:blueprint-count-range', branchId * BRANCH_BASE + 1, (branchId + 1) * BRANCH_BASE - 1)
      if (cancelled) return
      setExistingCount(n)
      setRangeStart(n + 1)
      setRangeEnd(n + 50)
      if (branchId !== 0) setRangeMode((m) => (m === 'full' ? 'front' : m))
    })()
    return () => { cancelled = true }
  }, [isOpen, branchId])

  if (!currentProject) return null
  const total = currentProject.novelConfig.totalChapters

  const handleConfirm = () => {
    // 防重复：同类型工作流正在运行
    if (isBatchRunning) {
      toast.warning(t('directoryConfig.taskRunning'))
      return
    }

    let params: DirectoryWorkflowParams

    if (rangeMode === 'full') {
      params = { mode: overwriteMode === 'full' ? 'full' : 'append', count: 0 }
    } else if (rangeMode === 'front') {
      if (existingCount > 0 && overwriteMode === 'append') {
        params = { mode: 'append', startChapter: existingCount + 1, count: Number(frontN) || 50 }
      } else {
        params = { mode: 'full', count: Number(frontN) || 50 }
      }
    } else {
      const start = Number(rangeStart) || 1
      const end = Math.max(start, Number(rangeEnd) || start)
      params = { mode: 'append', startChapter: start, count: Math.max(1, end - start + 1) }
    }

    onConfirm({ ...params, pacingGuidance: pacingGuidance.trim() || undefined, branchId: branchId || undefined })
    onClose()
    toast.info(t('directoryConfig.submitted'))
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText size={16} className="text-[var(--color-accent)]" />
            {t('directoryConfig.title')}
          </DialogTitle>
          <DialogDescription>
            {existingCount > 0
              ? t('directoryConfig.existingBlueprints', { count: existingCount })
              : t('directoryConfig.totalChaptersInfo', { total })}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {branches.length > 0 && (
            <div>
              <Label className="text-xs font-semibold mb-2 block" style={{ color: 'var(--color-text)' }}>
                {t('directoryConfig.targetBranch')}
              </Label>
              <NativeSelect
                value={String(branchId)}
                onChange={(e) => setBranchId(parseInt(e.target.value, 10) || 0)}
              >
                <option value="0">{t('directoryConfig.mainLine')}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.kind === 'if' ? `IF·${b.name}` : `番外·${b.name}`}</option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div>
            <Label className="text-xs font-semibold mb-2 block" style={{ color: 'var(--color-text)' }}>
              {t('directoryConfig.quantityLabel')}
            </Label>
            <div className="space-y-3 mt-2">
              <RadioOption
                checked={rangeMode === 'front'}
                onChange={() => setRangeMode('front')}
                label={
                  <span className="flex items-center gap-2">
                    {t('directoryConfig.batchGenerate')}
                    <Input
                      type="number"
                      value={frontN}
                      onChange={e => setFrontN(e.target.value === '' ? '' : parseInt(e.target.value))}
                      onBlur={() => {
                        const v = Number(frontN)
                        if (!v || v < 1) setFrontN(50)
                        else setFrontN(Math.min(branchId === 0 ? total : 999, v))
                      }}
                      className="w-16 h-6 text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    {t('directoryConfig.chapters')}
                  </span>
                }
              />
              <RadioOption
                checked={rangeMode === 'range'}
                onChange={() => setRangeMode('range')}
                label={
                  <span className="flex items-center gap-2">
                    {t('directoryConfig.specifyRange')}
                    <Input
                      type="number"
                      value={rangeStart}
                      onChange={e => setRangeStart(e.target.value === '' ? '' : parseInt(e.target.value))}
                      onBlur={() => {
                        const v = Number(rangeStart)
                        if (!v || v < 1) setRangeStart(1)
                        else if (v > existingCount + 1) setRangeStart(existingCount + 1)
                      }}
                      className="w-16 h-6 text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    {t('directoryConfig.toChapter')}
                    <Input
                      type="number"
                      value={rangeEnd}
                      onChange={e => setRangeEnd(e.target.value === '' ? '' : parseInt(e.target.value))}
                      onBlur={() => {
                        const v = Number(rangeEnd)
                        const start = Number(rangeStart) || 1
                        if (!v || v < start) setRangeEnd(start)
                      }}
                      className="w-16 h-6 text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    {t('directoryConfig.chapters')}
                  </span>
                }
              />
              {branchId === 0 && (
              <RadioOption
                checked={rangeMode === 'full'}
                onChange={() => setRangeMode('full')}
                label={t('directoryConfig.fullGenerate', { total })}
              />
              )}
            </div>
          </div>

          {existingCount > 0 && (
            <div
              className="rounded-lg p-3 space-y-2 mt-4"
              style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
            >
              <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                {t('directoryConfig.existingDataHandling')}
              </p>
              <div className="space-y-3 mt-2">
                <RadioOption
                  checked={overwriteMode === 'append'}
                  onChange={() => setOverwriteMode('append')}
                  label={t('directoryConfig.appendMode', { from: existingCount + 1 })}
                />
                <RadioOption
                  checked={overwriteMode === 'full'}
                  onChange={() => setOverwriteMode('full')}
                  label={t('directoryConfig.overwriteMode')}
                />
              </div>
            </div>
          )}

          {/* 节奏/风格指导（可选） */}
          <div>
            <Label className="text-xs font-semibold mb-2 block" style={{ color: 'var(--color-text)' }}>
              {t('directoryConfig.rhythmGuide')}
            </Label>
            <Textarea
              value={pacingGuidance}
              onChange={e => setPacingGuidance(e.target.value)}
              placeholder={t('directoryConfig.rhythmPlaceholder')}
              rows={2}
              className="text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('cancel', { ns: 'common' })}</Button>
          <Button variant="default" onClick={handleConfirm}>
            <FileText size={13} />
            {t('directoryConfig.startGeneration')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 单选按钮选项 */
function RadioOption({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: React.ReactNode
}) {
  return (
    <label
      className="flex items-center gap-2 text-xs cursor-pointer select-none"
      style={{ color: 'var(--color-text-secondary)' }}
      onClick={onChange}
    >
      <div
        className="w-3.5 h-3.5 rounded-full border flex items-center justify-center flex-shrink-0"
        style={{
          borderColor: checked ? 'var(--color-accent)' : 'var(--color-border)',
          backgroundColor: checked ? 'var(--color-accent)' : 'transparent',
        }}
      >
        {checked && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
      </div>
      {label}
    </label>
  )
}
