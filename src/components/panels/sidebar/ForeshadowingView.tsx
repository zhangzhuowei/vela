/**
 * ForeshadowingView — 伏笔/线索台账（侧边栏面板，Phase 2）
 *
 * 复用 db:foreshadow-* IPC：查看/新建/编辑/标记回收/重开/删除。
 * 监听 FINALIZE_COMPLETE：定稿后处理自动更新伏笔后刷新列表。
 */
import { useState, useEffect, useCallback } from 'react'
import { Milestone, RefreshCw, Plus, Check, Trash2, Pencil, RotateCcw } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { globalEventBus } from '../../../shared/event-bus'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../ui/Toast'
import { confirm } from '../../ui/Confirm'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../../ui/Dialog'
import { Input } from '../../ui/Input'
import { Label } from '../../ui/Label'
import { Textarea } from '../../ui/Textarea'
import { NativeSelect } from '../../ui/NativeSelect'
import type { ForeshadowingData } from '../../../../electron/repositories/foreshadowing-repository'

type EditState = {
  id: number | null // null = 新建
  content: string
  plantedChapter: string
  expectedChapter: string
  status: 'open' | 'paid' | 'abandoned'
  paidChapter: string
}

const EMPTY_EDIT: EditState = { id: null, content: '', plantedChapter: '1', expectedChapter: '', status: 'open', paidChapter: '' }

const STATUS_LABEL: Record<string, string> = { open: '未回收', paid: '已回收', abandoned: '已弃用' }
const STATUS_COLOR: Record<string, string> = {
  open: 'rgb(234,179,8)', paid: 'rgb(34,197,94)', abandoned: 'var(--color-text-muted)',
}

export default function ForeshadowingView() {
  const currentProject = useProjectStore(s => s.currentProject)
  const [items, setItems] = useState<ForeshadowingData[]>([])
  const [loading, setLoading] = useState(false)
  const [edit, setEdit] = useState<EditState | null>(null)

  const load = useCallback(async () => {
    if (!currentProject) return
    setLoading(true)
    try {
      const data = await ipc.invoke('db:foreshadow-get-all')
      setItems(data)
    } catch {
      toast.error('读取伏笔台账失败')
    } finally {
      setLoading(false)
    }
  }, [currentProject])

  useEffect(() => { load() }, [load])

  // 定稿后处理会自动更新伏笔，完成后刷新
  useEffect(() => {
    return globalEventBus.on('FINALIZE_COMPLETE', () => { load() })
  }, [load])

  const open = items.filter(i => i.status === 'open')
  const closed = items.filter(i => i.status !== 'open')

  const markPaid = async (item: ForeshadowingData) => {
    let paidChapter = item.plantedChapter
    try {
      const maxFinalized = await ipc.invoke('db:draft-get-max-finalized-chapter')
      if (maxFinalized && maxFinalized >= item.plantedChapter) paidChapter = maxFinalized
    } catch { /* 忽略 */ }
    await ipc.invoke('db:foreshadow-mark-paid', item.id, paidChapter)
    toast.success(`已标记回收（第${paidChapter}章）`)
    load()
  }

  const reopen = async (item: ForeshadowingData) => {
    await ipc.invoke('db:foreshadow-update', { ...item, status: 'open', paidChapter: null })
    load()
  }

  const remove = async (item: ForeshadowingData) => {
    const ok = await confirm(`确认删除该伏笔？\n\n"${item.content}"`, { title: '删除伏笔', confirmText: '删除', danger: true })
    if (!ok) return
    await ipc.invoke('db:foreshadow-delete', item.id)
    load()
  }

  const openEdit = (item?: ForeshadowingData) => {
    if (item) {
      setEdit({
        id: item.id,
        content: item.content,
        plantedChapter: String(item.plantedChapter),
        expectedChapter: item.expectedChapter != null ? String(item.expectedChapter) : '',
        status: item.status,
        paidChapter: item.paidChapter != null ? String(item.paidChapter) : '',
      })
    } else {
      setEdit({ ...EMPTY_EDIT })
    }
  }

  const saveEdit = async () => {
    if (!edit) return
    const content = edit.content.trim()
    if (!content) { toast.warning('请填写伏笔内容'); return }
    const planted = parseInt(edit.plantedChapter) || 1
    const expected = edit.expectedChapter.trim() ? parseInt(edit.expectedChapter) : null
    try {
      if (edit.id == null) {
        await ipc.invoke('db:foreshadow-create', { content, plantedChapter: planted, expectedChapter: expected })
      } else {
        const paid = edit.status === 'paid' && edit.paidChapter.trim() ? parseInt(edit.paidChapter) : null
        await ipc.invoke('db:foreshadow-update', {
          id: edit.id, content, plantedChapter: planted, expectedChapter: expected,
          status: edit.status, paidChapter: paid, notes: '', createdAt: '', updatedAt: '',
        })
      }
      setEdit(null)
      load()
    } catch (e) {
      toast.error(`保存失败：${e}`)
    }
  }

  if (!currentProject) {
    return <EmptyState icon={<Milestone size={36} />} message="请先打开项目" className="pb-[15vh]" opacity={0.4} />
  }

  const renderItem = (item: ForeshadowingData) => (
    <div
      key={item.id}
      className="group px-2.5 py-2 rounded-md text-xs mb-0.5 hover:bg-[var(--color-hover)]"
      style={{ color: 'var(--color-text-secondary)' }}
    >
      <div className="flex items-start gap-1.5">
        <span
          className="mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: STATUS_COLOR[item.status] }}
          title={STATUS_LABEL[item.status]}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[var(--color-text)] leading-snug">{item.content || '（无描述）'}</div>
          <div className="text-[0.65rem] mt-0.5 opacity-60">
            第{item.plantedChapter}章埋
            {item.status === 'open'
              ? (item.expectedChapter ? ` · 预期第${item.expectedChapter}章回收` : ' · 回收章未定')
              : (item.paidChapter ? ` · 已在第${item.paidChapter}章回收` : ` · ${STATUS_LABEL[item.status]}`)}
          </div>
          {/* 操作行（hover 显示） */}
          <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {item.status === 'open' ? (
              <button className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[var(--color-active)]" title="标记为已回收" onClick={() => markPaid(item)}>
                <Check size={12} /> 回收
              </button>
            ) : (
              <button className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[var(--color-active)]" title="重开为未回收" onClick={() => reopen(item)}>
                <RotateCcw size={12} /> 重开
              </button>
            )}
            <button className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[var(--color-active)]" title="编辑" onClick={() => openEdit(item)}>
              <Pencil size={12} />
            </button>
            <button className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[var(--color-active)]" title="删除" onClick={() => remove(item)}>
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-1">
          <Milestone size={13} />
          伏笔台账 ({open.length} 未回收 / {items.length})
        </span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => load()} title="刷新" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => openEdit()} title="新建伏笔">
            <Plus size={14} />
          </Button>
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-1">
        {items.length === 0 && (
          <div className="text-center py-6 opacity-30 text-xs">
            暂无伏笔<br />定稿章节后会自动抽取，也可手动新建
          </div>
        )}
        {open.length > 0 && (
          <div className="px-2 pt-1 pb-0.5 text-[0.65rem] font-medium opacity-50">未回收 ({open.length})</div>
        )}
        {open.map(renderItem)}
        {closed.length > 0 && (
          <div className="px-2 pt-2 pb-0.5 text-[0.65rem] font-medium opacity-50">已回收 / 弃用 ({closed.length})</div>
        )}
        {closed.map(renderItem)}
      </div>

      {/* 新建/编辑弹框 */}
      <Dialog open={edit !== null} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Milestone size={15} className="text-[var(--color-accent)]" />
              {edit?.id == null ? '新建伏笔' : '编辑伏笔'}
            </DialogTitle>
            <DialogDescription>记录一条需要后续回收的伏笔/线索</DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="px-5 py-3 space-y-3">
              <div>
                <Label>伏笔内容</Label>
                <Textarea
                  value={edit.content}
                  onChange={(e) => setEdit({ ...edit, content: e.target.value })}
                  placeholder="如：主角腰间的旧玉佩来历不明，似与反派有关"
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>埋设章节</Label>
                  <Input type="number" min={1} value={edit.plantedChapter}
                    onChange={(e) => setEdit({ ...edit, plantedChapter: e.target.value })} />
                </div>
                <div>
                  <Label>预期回收章（可选）</Label>
                  <Input type="number" min={1} value={edit.expectedChapter}
                    onChange={(e) => setEdit({ ...edit, expectedChapter: e.target.value })} placeholder="留空=未定" />
                </div>
              </div>
              {edit.id != null && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>状态</Label>
                    <NativeSelect value={edit.status}
                      onChange={(e) => setEdit({ ...edit, status: e.target.value as EditState['status'] })}>
                      <option value="open">未回收</option>
                      <option value="paid">已回收</option>
                      <option value="abandoned">已弃用</option>
                    </NativeSelect>
                  </div>
                  {edit.status === 'paid' && (
                    <div>
                      <Label>回收章节</Label>
                      <Input type="number" min={1} value={edit.paidChapter}
                        onChange={(e) => setEdit({ ...edit, paidChapter: e.target.value })} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>取消</Button>
            <Button variant="ai" onClick={saveEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
