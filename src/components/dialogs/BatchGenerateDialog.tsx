import { useState, useEffect, useCallback } from 'react'
import { Layers, Play, AlertCircle } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { createBatchGenerateWorkflow } from '../../services/workflows/chapter-workflow'
import { guardChapterWriting } from '../../services/workflow-guards'
import { ipc } from '../../services/ipc-client'
import { toast } from '../ui/Toast'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import type { ModelProfile } from '../../shared/ipc-channels'

interface Props {
  isOpen: boolean
  onClose: () => void
}

/** 复选开关行 */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer select-none" style={{ color: 'var(--color-text-secondary)' }}>
      <div
        className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
        style={{
          borderColor: checked ? 'var(--color-accent)' : 'var(--color-border)',
          backgroundColor: checked ? 'var(--color-accent)' : 'transparent',
        }}
        onClick={() => onChange(!checked)}
      >
        {checked && <svg width="8" height="6" viewBox="0 0 9 7" fill="none"><path d="M1 3L3.5 5.5L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </div>
      <span onClick={() => onChange(!checked)}>{label}</span>
    </label>
  )
}

/** 单个任务的模型选择行 */
function ModelRow({ label, value, onChange, models }: {
  label: string; value: string; onChange: (v: string) => void; models: ModelProfile[]
}) {
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
      <span className="w-14 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} className="h-7 text-xs py-0 flex-1">
        <option value="">默认模型</option>
        {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </NativeSelect>
    </div>
  )
}

/**
 * 批量无人值守生成对话框（设计文档 #3）
 * 配置章节范围与各环节开关，启动 batch_generate 工作流。
 */
export default function BatchGenerateDialog({ isOpen, onClose }: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const models = useLLMStore(s => s.models)
  const startWorkflow = useWorkflowStore.getState().startWorkflow
  const isBatchRunning = useWorkflowStore(s => s.isTypeRunning('batch_generate'))

  // 按任务派模型（''=默认模型）
  const [blueprintModel, setBlueprintModel] = useState('')
  const [writeModel, setWriteModel] = useState('')
  const [reviewModel, setReviewModel] = useState('')
  const [deaifyModel, setDeaifyModel] = useState('')

  const [startChapter, setStartChapter] = useState<number | ''>(1)
  const [endChapter, setEndChapter] = useState<number | ''>(1)
  const [autoReview, setAutoReview] = useState(true)
  const [reviewMaxRounds, setReviewMaxRounds] = useState(3)
  const [reviewGate, setReviewGate] = useState<'error' | 'error+warning'>('error')
  const [deaify, setDeaify] = useState(false)
  const [deaifyIntensity, setDeaifyIntensity] = useState<'轻' | '中' | '重'>('中')
  const [onReviewFail, setOnReviewFail] = useState<'stop' | 'continue'>('stop')
  const [resume, setResume] = useState(true)
  // 滚动蓝图：默认开启（静态蓝图是长篇连写质量下滑的主因）
  const [rollingBlueprint, setRollingBlueprint] = useState(true)
  const [guardError, setGuardError] = useState<string | null>(null)

  // 打开时按"下一待写章"和总章数推断默认范围
  const initDefaults = useCallback(async () => {
    if (!currentProject) return
    setGuardError(null)
    let nextWrite = 1
    try {
      const maxFinalized = await ipc.invoke('db:draft-get-max-finalized-chapter')
      nextWrite = (maxFinalized || 0) + 1
    } catch { /* 忽略 */ }
    const total = currentProject.novelConfig.totalChapters || nextWrite
    setStartChapter(nextWrite)
    setEndChapter(Math.min(total, nextWrite + 9))
  }, [currentProject])

  useEffect(() => {
    if (isOpen) initDefaults()
  }, [isOpen, initDefaults])

  if (!currentProject) return null

  const s = Number(startChapter) || 1
  const e = Math.max(s, Number(endChapter) || s)
  const chapterCount = e - s + 1
  // 粗略调用量：（蓝图刷新 1）+ 写1 +（审校：最多 maxRounds 审 + maxRounds-1 修）+（去AI味 1）
  const perChapter = (rollingBlueprint ? 1 : 0) + 1 + (autoReview ? reviewMaxRounds * 2 - 1 : 0) + (deaify ? 1 : 0)
  const estCalls = chapterCount * perChapter

  const handleStart = async () => {
    if (!defaultModelId) {
      toast.error('请先配置 AI 模型')
      return
    }
    if (isBatchRunning) {
      toast.warning('已有批量任务正在执行，请等待完成后再试')
      return
    }
    // 前置校验：起始章能否写（蓝图存在、前一章已定稿等）
    const guard = await guardChapterWriting(s)
    if (!guard.ok) {
      setGuardError(guard.message || '前置条件未满足')
      return
    }
    setGuardError(null)

    startWorkflow(createBatchGenerateWorkflow({
      startChapter: s,
      endChapter: e,
      autoReview,
      reviewMaxRounds,
      reviewGate,
      deaify,
      deaifyIntensity,
      onReviewFail,
      resume,
      rollingBlueprint,
      models: {
        blueprint: blueprintModel || undefined,
        write: writeModel || undefined,
        review: reviewModel || undefined,
        deaify: deaifyModel || undefined,
      },
    }), false)
    onClose()
    toast.info(`📚 已启动批量生成：第 ${s}-${e} 章`)
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && !isBatchRunning && onClose()}>
      <DialogContent className="max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers size={16} className="text-[var(--color-accent)]" />
            批量无人值守生成
          </DialogTitle>
          <DialogDescription>
            连续生成多章：刷新蓝图 → 写稿 → 审校闭环 → 去AI味 → 定稿，全自动串联
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {/* 范围 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>起始章</Label>
              <Input
                type="number" min={1} value={startChapter}
                onChange={(ev) => setStartChapter(ev.target.value === '' ? '' : parseInt(ev.target.value))}
                onBlur={() => { if (!Number(startChapter)) setStartChapter(1) }}
              />
            </div>
            <div>
              <Label>结束章</Label>
              <Input
                type="number" min={1} value={endChapter}
                onChange={(ev) => setEndChapter(ev.target.value === '' ? '' : parseInt(ev.target.value))}
                onBlur={() => { if (Number(endChapter) < s) setEndChapter(s) }}
              />
            </div>
          </div>

          {/* 各环节开关 */}
          <div className="rounded-lg p-3 space-y-3" style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}>
            <Toggle
              checked={rollingBlueprint}
              onChange={setRollingBlueprint}
              label="滚动蓝图：写稿前按已写剧情自适应修正本章蓝图（推荐）"
            />
            {rollingBlueprint ? (
              <div className="ml-6 text-[0.7rem] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                依据已定稿正文、角色当前状态、未回收伏笔与节奏位置修正蓝图，主线定位保持不变。
                长篇连写主要靠它避免「越写越飘」。
              </div>
            ) : (
              <div className="ml-6 text-[0.7rem] leading-relaxed" style={{ color: 'var(--color-warning, #eab308)' }}>
                关闭后将沿用开写前规划的静态蓝图，连写多章时剧情偏差会逐章累积。
              </div>
            )}
            <Toggle checked={autoReview} onChange={setAutoReview} label="每章写完后自动审校闭环（审稿→修复→复审）" />
            {autoReview && (
              <div className="ml-6 flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  最多
                  <Input
                    type="number" min={1} max={5} value={reviewMaxRounds}
                    onChange={(ev) => setReviewMaxRounds(Math.max(1, Math.min(5, parseInt(ev.target.value) || 1)))}
                    className="w-14 h-6 text-xs px-2 py-0"
                  />
                  轮
                </span>
                <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  门控
                  <NativeSelect value={reviewGate} onChange={(ev) => setReviewGate(ev.target.value as 'error' | 'error+warning')} className="h-6 text-xs py-0">
                    <option value="error">仅严重问题(error)</option>
                    <option value="error+warning">严格(error+warning)</option>
                  </NativeSelect>
                </span>
              </div>
            )}
            <Toggle checked={deaify} onChange={setDeaify} label="定稿前做去AI味清洗（自动合并）" />
            {deaify && (
              <div className="ml-6 flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                强度
                <NativeSelect value={deaifyIntensity} onChange={(ev) => setDeaifyIntensity(ev.target.value as '轻' | '中' | '重')} className="h-6 text-xs py-0">
                  <option value="轻">轻</option>
                  <option value="中">中</option>
                  <option value="重">重</option>
                </NativeSelect>
              </div>
            )}
            <Toggle checked={resume} onChange={setResume} label="断点续跑：跳过已定稿的章节" />
          </div>

          {/* 按任务派模型（可选）—— 写稿用强模型、审校/去AI味用便宜快模型可显著省钱提速 */}
          {models.length > 1 && (
            <div className="rounded-lg p-3 space-y-2" style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}>
              <div className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                按任务派模型 <span className="font-normal" style={{ color: 'var(--color-text-muted)' }}>（可选，默认都用默认模型）</span>
              </div>
              {rollingBlueprint && <ModelRow label="蓝图" value={blueprintModel} onChange={setBlueprintModel} models={models} />}
              <ModelRow label="写稿" value={writeModel} onChange={setWriteModel} models={models} />
              {autoReview && <ModelRow label="审校" value={reviewModel} onChange={setReviewModel} models={models} />}
              {deaify && <ModelRow label="去AI味" value={deaifyModel} onChange={setDeaifyModel} models={models} />}
            </div>
          )}

          {/* 审校未通过策略 */}
          {autoReview && (
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <span>审校未通过时：</span>
              <NativeSelect value={onReviewFail} onChange={(ev) => setOnReviewFail(ev.target.value as 'stop' | 'continue')} className="h-7 text-xs py-0 flex-1">
                <option value="stop">停止批量（交人工处理）</option>
                <option value="continue">带问题继续定稿</option>
              </NativeSelect>
            </div>
          )}

          {/* 成本提示 */}
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'rgba(var(--color-accent-rgb),0.08)', color: 'var(--color-text-muted)' }}>
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-accent)' }} />
            <span>
              共 <b style={{ color: 'var(--color-text)' }}>{chapterCount}</b> 章，预计最多约 <b style={{ color: 'var(--color-text)' }}>{estCalls}</b> 次 LLM 调用。
              批量长跑会消耗较多 token/额度，且每章会自动定稿（不可逆）。可随时在任务面板取消。
            </span>
          </div>
        </div>

        <DialogFooter className="items-center">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="ai" size="lg" onClick={handleStart} disabled={isBatchRunning}>
            {isBatchRunning ? (
              <span className="flex items-center gap-2"><span className="animate-spin">🌀</span> 批量生成中...</span>
            ) : (
              <span className="flex items-center gap-2"><Play size={13} /> 开始批量生成</span>
            )}
          </Button>
        </DialogFooter>

        {guardError && (
          <div className="mx-5 mb-4 flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 dark:text-yellow-400">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5 text-yellow-500" />
            <span className="whitespace-pre-line">{guardError}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
