import { useState, useEffect, useCallback } from 'react'
import { Image as ImageIcon, Loader2, Trash2, Plus, RefreshCw } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import { useLLMStore } from '../../stores/llm-store'
import type { ChapterImageData } from '../../../electron/repositories/chapter-image-repository'
import { toast } from '../ui/Toast'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'

interface Props {
  chapterNumber: number
  chapterTitle?: string
  projectPath: string
}

/**
 * 本章配图面板
 *  - 题图（header）：每章至多一张
 *  - 场景插图（scene）：按需多张
 * 复用 image:generate / image:read + db:chapter-image-*，图片存 .vela/images/。
 */
export default function ChapterImagesPanel({ chapterNumber, chapterTitle, projectPath }: Props) {
  const [images, setImages] = useState<ChapterImageData[]>([])
  const [dataUrls, setDataUrls] = useState<Record<number, string>>({})
  const [generating, setGenerating] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogKind, setDialogKind] = useState<'header' | 'scene'>('scene')
  const [promptText, setPromptText] = useState('')
  const [refine, setRefine] = useState(true)

  const loadList = useCallback(async () => {
    try {
      const list = await ipc.invoke('db:chapter-image-list', chapterNumber)
      setImages(list)
    } catch { /* 忽略 */ }
  }, [chapterNumber])

  useEffect(() => { loadList() }, [loadList])

  // images 变化时，为尚未加载 dataUrl 的图片读取本地文件
  useEffect(() => {
    images.forEach((img) => {
      if (dataUrls[img.id] === undefined) {
        ipc.invoke('image:read', img.path).then((r) => {
          if (r.success && r.dataUrl) setDataUrls((prev) => ({ ...prev, [img.id]: r.dataUrl! }))
        }).catch(() => { })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images])

  const header = images.find((i) => i.kind === 'header') || null
  const scenes = images.filter((i) => i.kind === 'scene')

  const openDialog = (kind: 'header' | 'scene') => {
    setDialogKind(kind)
    setPromptText(kind === 'header' && chapterTitle ? `《${chapterTitle}》的封面题图，` : '')
    setRefine(true)
    setDialogOpen(true)
  }

  const handleGenerate = async () => {
    if (!promptText.trim()) { toast.warning('请先填写画面描述'); return }
    const llm = useLLMStore.getState()
    const imgModel = llm.models.find((m) => m.id === llm.defaultImageModelId)
      ?? llm.models.find((m) => m.purposes?.includes('image'))
    if (!imgModel) { toast.warning('请先在 设置 → 文生图模型 里配置一个模型'); return }

    const kind = dialogKind
    const useRefine = refine
    const rawPrompt = promptText.trim()
    setDialogOpen(false)
    setGenerating(true)
    try {
      let prompt = rawPrompt
      if (useRefine && llm.defaultModelId) {
        try {
          const r = await llm.generate([
            { role: 'system', content: '你是文生图提示词工程师。把下面的画面/场景描述润色成一段用于文生图的中文提示词，聚焦主体、动作、环境、光影、构图与画面质感，80-140字，只输出提示词本身，不要任何解释。' },
            { role: 'user', content: rawPrompt },
          ])
          if (r.success && r.content.trim()) prompt = r.content.trim()
        } catch { /* 用原始 prompt */ }
      }
      const res = await ipc.invoke('image:generate', {
        model: imgModel,
        prompt,
        projectPath,
        size: '1024x1024',
        filenameHint: `ch${chapterNumber}-${kind}`,
      })
      if (res.success && res.path) {
        await ipc.invoke('db:chapter-image-add', { chapterNumber, kind, path: res.path, prompt })
        await loadList()
        toast.success(kind === 'header' ? '题图已生成' : '场景插图已生成')
      } else {
        toast.error(`生成失败：${res.error ?? '未知错误'}`)
      }
    } catch (e) {
      toast.error(`生成失败：${e}`)
    } finally {
      setGenerating(false)
    }
  }

  const handleDelete = async (id: number) => {
    await ipc.invoke('db:chapter-image-delete', id)
    setImages((prev) => prev.filter((i) => i.id !== id))
    setDataUrls((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const renderThumb = (img: ChapterImageData, size: number) => (
    <div key={img.id} className="relative group flex-shrink-0" style={{ width: size, height: size }}>
      {dataUrls[img.id]
        ? <img src={dataUrls[img.id]} alt={img.prompt} title={img.prompt} className="w-full h-full object-cover rounded-md" style={{ border: '1px solid var(--color-border)' }} />
        : <div className="w-full h-full rounded-md flex items-center justify-center" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}><Loader2 size={16} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} /></div>}
      <button
        onClick={() => handleDelete(img.id)}
        title="删除"
        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ backgroundColor: 'rgba(0,0,0,0.55)', color: '#fff' }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  )

  return (
    <div className="px-3 py-2 space-y-2" style={{ borderBottom: '1px solid var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}>
      {/* 题图 */}
      <div className="flex items-start gap-3">
        <div className="text-xs font-medium flex-shrink-0 pt-1" style={{ color: 'var(--color-text-muted)', width: 40 }}>题图</div>
        {header
          ? (
            <div className="flex items-center gap-2">
              {renderThumb(header, 88)}
              <Button variant="outline" size="sm" onClick={() => openDialog('header')} disabled={generating}>
                <RefreshCw size={12} /> 重新生成
              </Button>
            </div>
          )
          : (
            <Button variant="outline" size="sm" onClick={() => openDialog('header')} disabled={generating}>
              {generating ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />} 生成题图
            </Button>
          )}
      </div>

      {/* 场景插图 */}
      <div className="flex items-start gap-3">
        <div className="text-xs font-medium flex-shrink-0 pt-1" style={{ color: 'var(--color-text-muted)', width: 40 }}>插图</div>
        <div className="flex flex-wrap items-center gap-2">
          {scenes.map((s) => renderThumb(s, 72))}
          <Button variant="outline" size="sm" onClick={() => openDialog('scene')} disabled={generating}>
            {generating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} 场景插图
          </Button>
        </div>
      </div>

      {/* 生成弹框 */}
      <Dialog open={dialogOpen} onOpenChange={(v) => !v && setDialogOpen(false)}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ImageIcon size={15} className="text-[var(--color-accent)]" />
              {dialogKind === 'header' ? '生成章节题图' : '生成场景插图'}
            </DialogTitle>
            <DialogDescription>
              {dialogKind === 'header' ? '为本章生成一张顶部题图' : '描述一个想要配图的场景'}（第 {chapterNumber} 章）
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-2 space-y-2">
            <label className="text-xs font-medium block" style={{ color: 'var(--color-text-secondary)' }}>画面描述</label>
            <Textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              rows={4}
              placeholder={dialogKind === 'header' ? '如：末世废土城市天际线，主角背影，冷峻氛围…' : '如：主角在雨夜天台与反派对峙，霓虹光影，仰视构图…'}
            />
            <label className="flex items-center gap-2 text-xs cursor-pointer select-none" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} />
              先用文本模型把描述润色成规范画图提示词（推荐）
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button variant="ai" onClick={handleGenerate}>生成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
