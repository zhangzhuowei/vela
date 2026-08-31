/**
 * DialogueEditor — 对话创作模式的章节编辑器
 *
 * 左：场列表；中：对话流 + 控场输入；收场时蒸馏预览对照可改。
 * 汇稿把全部已收场正文写入草稿箱，之后走原生 修稿/定稿 流程。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelRightClose, PanelRightOpen, Plus, RefreshCw, Send, Square, Trash2, Undo2 } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import {
  assembleToDraft,
  commitScene,
  distillScene,
  generateTurn,
  previewChapterBody,
} from '../../services/dialogue/dialogue-service'
import { NativeSelect } from '../ui/NativeSelect'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import type { SceneData, SceneTurnData } from '../../../electron/repositories/scene-repository'
import type { WorkingState } from '../../shared/ipc-channels'

export default function DialogueEditor({ chapterNumber }: { chapterNumber: number }) {
  const { t } = useTranslation('editors')
  const projectName = useProjectStore((s) => s.currentProject?.name)
  const [scenes, setScenes] = useState<SceneData[]>([])
  const [sceneId, setSceneId] = useState<number | null>(null)
  const [turns, setTurns] = useState<SceneTurnData[]>([])
  const [workingState, setWorkingState] = useState<WorkingState>({})
  const [chapterTitle, setChapterTitle] = useState(`第${chapterNumber}章`)
  const [chapterGoal, setChapterGoal] = useState('')
  const [input, setInput] = useState('')
  const [newSceneTitle, setNewSceneTitle] = useState('')
  const [streaming, setStreaming] = useState('')
  const [distillDraft, setDistillDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [goalDraft, setGoalDraft] = useState('')
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  // 蒸馏专用模型（'' = 跟随默认生成模型），本机记忆
  const [distillModelId, setDistillModelId] = useState(() => localStorage.getItem('vela-distill-model') ?? '')
  const llmModels = useLLMStore((s) => s.models)
  // 汇稿预览（非 null 时显示确认弹层）
  const [assemblePreview, setAssemblePreview] = useState<string | null>(null)
  // 右侧状态栏收起/展开，本机记忆
  const [statePanelOpen, setStatePanelOpen] = useState(
    () => localStorage.getItem('vela-dialogue-state-panel') !== 'closed'
  )
  const toggleStatePanel = () => {
    setStatePanelOpen((prev) => {
      localStorage.setItem('vela-dialogue-state-panel', prev ? 'closed' : 'open')
      return !prev
    })
  }
  const scrollRef = useRef<HTMLDivElement>(null)

  const scene = scenes.find((s) => s.id === sceneId) ?? null

  const loadScenes = useCallback(async () => {
    const items = await ipc.invoke('db:scene-list', chapterNumber)
    setScenes(items)
    return items
  }, [chapterNumber])

  useEffect(() => {
    void (async () => {
      const bp = await ipc.invoke('db:blueprint-get', chapterNumber)
      if (bp) {
        if (bp.title) setChapterTitle(bp.title)
        setChapterGoal(bp.purpose || bp.keyEvents || '')
      }
      const items = await loadScenes()
      setSceneId((prev) => prev ?? items.find((s) => s.status === 'open')?.id ?? items[0]?.id ?? null)
      setWorkingState(await ipc.invoke('db:chapter-working-state-get', chapterNumber))
    })()
  }, [chapterNumber, loadScenes])

  useEffect(() => {
    setDistillDraft(null)
    setError('')
    if (sceneId == null) {
      setTurns([])
      return
    }
    void ipc.invoke('db:scene-turn-list', sceneId).then(setTurns)
  }, [sceneId])

  // 切场时同步场目标草稿
  useEffect(() => {
    setGoalDraft(scene?.goal ?? '')
  }, [scene?.id, scene?.goal])

  const saveGoal = () => {
    if (!scene || goalDraft === scene.goal) return
    void ipc.invoke('db:scene-update', scene.id, { goal: goalDraft.trim() }).then(() => loadScenes())
  }

  const saveWorkingState = (next: WorkingState) => {
    setWorkingState(next)
    void ipc.invoke('db:chapter-working-state-set', chapterNumber, next)
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, streaming])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleGenerate = (retry: boolean) => {
    if (!scene) return
    const text = input.trim()
    if (!retry && !text) return
    setBusy(true)
    setError('')
    setStreaming('')
    void generateTurn({
      scene,
      chapterTitle,
      chapterGoal,
      userInput: text,
      retry,
      callbacks: {
        onChunk: (chunk) => setStreaming((prev) => prev + chunk),
        onDone: (nextTurns, nextState) => {
          setTurns(nextTurns)
          setWorkingState(nextState)
          setStreaming('')
          if (!retry) setInput('')
          setBusy(false)
          setActiveRequestId(null)
        },
        onError: (msg) => {
          setStreaming('')
          setError(msg)
          setBusy(false)
          setActiveRequestId(null)
        },
      },
    }).then((requestId) => setActiveRequestId(requestId || null))
  }

  const handleStop = () => {
    if (activeRequestId) void useLLMStore.getState().cancelGeneration(activeRequestId)
  }

  // 蒸馏（流式）：草稿区实时增长，完成后替换为剥离状态块的干净稿
  const handleDistill = () => {
    if (!scene) return
    setBusy(true)
    setError('')
    setDistillDraft('')
    void distillScene({
      scene,
      chapterTitle,
      chapterGoal,
      modelId: distillModelId || undefined,
      callbacks: {
        onChunk: (chunk) => setDistillDraft((prev) => (prev ?? '') + chunk),
        onDone: (draft) => {
          setDistillDraft(draft)
          setBusy(false)
          setActiveRequestId(null)
        },
        onError: (msg) => {
          setDistillDraft(null)
          setError(msg)
          setBusy(false)
          setActiveRequestId(null)
        },
      },
    })
      .then((requestId) => setActiveRequestId(requestId || null))
      .catch((err) => {
        setDistillDraft(null)
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const handleUndoTurn = () => {
    if (!scene || turns.length === 0) return
    void run(async () => {
      const res = await ipc.invoke('db:scene-turn-delete-last', scene.id)
      if (!res.success) throw new Error(res.error)
      setTurns(await ipc.invoke('db:scene-turn-list', scene.id))
    })
  }

  const liveProse = (raw: string) => {
    const cut = raw.search(/<state>/i)
    return (cut === -1 ? raw : raw.slice(0, cut)).trimEnd()
  }

  return (
    <div className="flex h-full">
      {/* 场列表 */}
      <aside
        className="flex w-56 flex-shrink-0 flex-col"
        style={{ borderRight: '1px solid var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="panel-header">{t('dialogue.scenes')}</div>
        <div className="flex gap-1 p-2">
          <Input
            value={newSceneTitle}
            onChange={(e) => setNewSceneTitle(e.target.value)}
            placeholder={t('dialogue.sceneTitlePlaceholder')}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !newSceneTitle.trim()}
            onClick={() =>
              void run(async () => {
                const res = await ipc.invoke('db:scene-create', chapterNumber, newSceneTitle.trim(), '')
                if (!res.success) throw new Error(res.error)
                setNewSceneTitle('')
                const items = await loadScenes()
                setSceneId(res.id ?? items[items.length - 1]?.id ?? null)
              })
            }
          >
            <Plus size={13} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto pb-2">
          {scenes.length === 0 && (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('dialogue.noScenes')}
            </p>
          )}
          {scenes.map((s) => (
            <div
              key={s.id}
              className={`tree-item ${s.id === sceneId ? 'active' : ''}`}
              onClick={() => setSceneId(s.id)}
            >
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{
                  backgroundColor: s.status === 'distilled' ? 'var(--color-success)' : 'var(--color-warning)',
                }}
              />
              <span className="min-w-0 flex-1 truncate text-xs">{s.title || `场${s.seq}`}</span>
              {s.status === 'open' && (
                <button
                  className="icon-btn"
                  title={t('dialogue.deleteScene')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void run(async () => {
                      const res = await ipc.invoke('db:scene-delete', s.id)
                      if (!res.success) throw new Error(res.error)
                      const items = await loadScenes()
                      if (sceneId === s.id) setSceneId(items[0]?.id ?? null)
                    })
                  }}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="p-2" style={{ borderTop: '1px solid var(--color-border)' }}>
          <Button
            variant="ai"
            size="sm"
            className="w-full"
            disabled={busy || scenes.length === 0 || scenes.some((s) => s.status !== 'distilled')}
            title={t('dialogue.assembleTooltip')}
            onClick={() =>
              void run(async () => {
                setAssemblePreview(await previewChapterBody(chapterNumber))
              })
            }
          >
            {t('dialogue.assemble')}
          </Button>
        </div>
      </aside>

      {/* 对话区 */}
      <main className="flex min-w-0 flex-1 flex-col" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
        <div className="panel-header justify-between">
          <span className="truncate">
            {projectName} · {chapterTitle}
            {scene ? ` · ${scene.title || `场${scene.seq}`}` : ''}
          </span>
          <button
            className="icon-btn hidden flex-shrink-0 xl:flex"
            title={t('dialogue.workingState')}
            onClick={toggleStatePanel}
          >
            {statePanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
        </div>
        {(error || notice) && (
          <div
            className="px-4 py-1 text-xs"
            style={{ color: error ? 'var(--color-error)' : 'var(--color-success)' }}
          >
            {error || notice}
          </div>
        )}
        {!scene ? (
          <div
            className="flex flex-1 items-center justify-center text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('dialogue.empty')}
          </div>
        ) : (
          <>
            <div
              className="flex items-center gap-2 px-4 py-1.5"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <span className="flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {t('dialogue.sceneGoal')}
              </span>
              <Input
                value={goalDraft}
                disabled={scene.status !== 'open'}
                onChange={(e) => setGoalDraft(e.target.value)}
                onBlur={saveGoal}
                placeholder={t('dialogue.sceneGoalPlaceholder')}
              />
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
              {turns.map((turn) => (
                <div key={turn.id} className={turn.role === 'user' ? 'text-right' : 'text-left'}>
                  <div
                    className="inline-block max-w-[82%] whitespace-pre-wrap rounded-xl px-4 py-2.5 text-left text-sm leading-7"
                    style={{
                      backgroundColor:
                        turn.role === 'user' ? 'var(--color-active)' : 'var(--color-sidebar)',
                      fontFamily: turn.role === 'assistant' ? 'var(--font-writing)' : undefined,
                    }}
                  >
                    {turn.content}
                  </div>
                </div>
              ))}
              {streaming && (
                <div className="text-left">
                  <div
                    className="inline-block max-w-[82%] whitespace-pre-wrap rounded-xl px-4 py-2.5 text-sm leading-7"
                    style={{ backgroundColor: 'var(--color-sidebar)', fontFamily: 'var(--font-writing)' }}
                  >
                    {liveProse(streaming) || '…'}
                    <span className="ai-stream-cursor" />
                  </div>
                </div>
              )}
              {distillDraft !== null && scene.status === 'open' && (
                <div
                  className="rounded-xl p-3"
                  style={{ border: '1px solid var(--color-warning)', backgroundColor: 'var(--color-sidebar)' }}
                >
                  <div className="mb-1 text-xs" style={{ color: 'var(--color-warning)' }}>
                    {t('dialogue.previewHint')}
                  </div>
                  <textarea
                    className="config-input h-48"
                    style={{ fontFamily: 'var(--font-writing)', fontSize: 13, lineHeight: 1.7 }}
                    value={distillDraft}
                    disabled={busy}
                    onChange={(e) => setDistillDraft(e.target.value)}
                  />
                </div>
              )}
              {scene.status === 'distilled' && scene.body && (
                <div
                  className="rounded-xl p-3"
                  style={{ border: '1px solid var(--color-success)', backgroundColor: 'var(--color-sidebar)' }}
                >
                  <div className="mb-1 text-xs" style={{ color: 'var(--color-success)' }}>
                    {t('dialogue.committedHint')}
                  </div>
                  <div
                    className="whitespace-pre-wrap text-sm leading-7"
                    style={{ fontFamily: 'var(--font-writing)' }}
                  >
                    {scene.body}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-2 p-3" style={{ borderTop: '1px solid var(--color-border)' }}>
              {/* 控场快捷板：点击填入输入框，可继续编辑 */}
              {scene.status === 'open' && (
                <div className="flex flex-wrap gap-1.5">
                  {(t('dialogue.quickDirectives', { returnObjects: true }) as string[]).map((preset) => (
                    <button
                      key={preset}
                      className="rounded-full px-2.5 py-1 text-[0.68rem] transition-colors hover:bg-[var(--color-accent)] hover:text-white"
                      style={{
                        border: '1px solid var(--color-border)',
                        backgroundColor: 'var(--color-hover)',
                        color: 'var(--color-text-secondary)',
                      }}
                      disabled={busy}
                      onClick={() => setInput((prev) => (prev.trim() ? `${prev} ${preset}` : preset))}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                className="config-input h-16"
                placeholder={t('dialogue.inputPlaceholder')}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(false)
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ai"
                  size="sm"
                  disabled={busy || !input.trim() || scene.status !== 'open'}
                  onClick={() => handleGenerate(false)}
                >
                  <Send size={12} /> {t('dialogue.send')}
                </Button>
                {busy && activeRequestId && (
                  <Button variant="destructive" size="sm" onClick={handleStop}>
                    <Square size={12} /> {t('dialogue.stop')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    busy || scene.status !== 'open' || turns[turns.length - 1]?.role !== 'user'
                  }
                  onClick={() => handleGenerate(true)}
                >
                  <RefreshCw size={12} /> {t('dialogue.retry')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || scene.status !== 'open' || turns.length === 0}
                  title={t('dialogue.undoTurnTooltip')}
                  onClick={handleUndoTurn}
                >
                  <Undo2 size={12} /> {t('dialogue.undoTurn')}
                </Button>
                {scene.status === 'open' && distillDraft === null && (
                  <>
                    <NativeSelect
                      className="w-36"
                      title={t('dialogue.distillModelTooltip')}
                      value={distillModelId}
                      onChange={(e) => {
                        setDistillModelId(e.target.value)
                        localStorage.setItem('vela-distill-model', e.target.value)
                      }}
                    >
                      <option value="">{t('dialogue.distillModelDefault')}</option>
                      {llmModels
                        .filter((m) => m.purposes.some((p) => p === 'generation' || p === 'refinement'))
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </NativeSelect>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || turns.length === 0}
                      onClick={handleDistill}
                    >
                      {t('dialogue.distill')}
                    </Button>
                  </>
                )}
                {scene.status === 'open' && distillDraft !== null && (
                  <>
                    <Button
                      variant="success"
                      size="sm"
                      disabled={busy || !distillDraft.trim()}
                      onClick={() =>
                        void run(async () => {
                          await commitScene(scene.id, distillDraft.trim())
                          setDistillDraft(null)
                          await loadScenes()
                        })
                      }
                    >
                      {t('dialogue.commit')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={handleDistill}>
                      {t('dialogue.redistill')}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDistillDraft(null)}>
                      {t('dialogue.cancelPreview')}
                    </Button>
                  </>
                )}
                {scene.status === 'distilled' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const res = await ipc.invoke('db:scene-reopen', scene.id)
                        if (!res.success) throw new Error(res.error)
                        await loadScenes()
                      })
                    }
                  >
                    {t('dialogue.reopen')}
                  </Button>
                )}
                {busy && (
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {t('dialogue.generating')}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* 进行中状态侧栏（可收起） */}
      {statePanelOpen && (
      <aside
        className="hidden w-60 flex-shrink-0 flex-col overflow-y-auto xl:flex"
        style={{ borderLeft: '1px solid var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="panel-header">{t('dialogue.workingState')}</div>
        <div className="space-y-2 p-2">
          <p className="px-1 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
            {t('dialogue.stateEditHint')}
          </p>
          {Object.keys(workingState).length === 0 && (
            <p className="px-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              —
            </p>
          )}
          {Object.entries(workingState).map(([name, fields]) => (
            <div
              key={name}
              className="rounded-lg p-2"
              style={{ border: '1px solid var(--color-border)' }}
            >
              <div className="mb-1 text-xs font-semibold">{name}</div>
              {Object.entries(fields).map(([k, v]) => (
                <label key={k} className="mb-1 block text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                  {k}
                  <textarea
                    className="config-input mt-0.5 min-h-0 resize-none py-1 text-[0.7rem] leading-4"
                    rows={Math.min(4, Math.max(1, Math.ceil(v.length / 16)))}
                    value={v}
                    onChange={(e) =>
                      setWorkingState((prev) => ({
                        ...prev,
                        [name]: { ...prev[name], [k]: e.target.value },
                      }))
                    }
                    onBlur={() => saveWorkingState(workingState)}
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      </aside>
      )}

      {/* 汇稿预览确认弹层 */}
      {assemblePreview !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-8"
          style={{ backgroundColor: 'var(--color-backdrop)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => e.target === e.currentTarget && setAssemblePreview(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl"
            style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
          >
            <div
              className="flex items-center justify-between px-5 py-3"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <span className="text-sm font-semibold">{t('dialogue.assemblePreviewTitle')}</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {t('dialogue.assemblePreviewStats', {
                  scenes: scenes.filter((s) => s.status === 'distilled').length,
                  words: assemblePreview.replace(/\s/g, '').length,
                })}
              </span>
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-6 py-4 text-sm leading-7"
              style={{ fontFamily: 'var(--font-writing)' }}
            >
              {assemblePreview}
            </div>
            <div
              className="flex items-center justify-end gap-2 px-5 py-3"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAssemblePreview(null)}>
                {t('dialogue.cancelPreview')}
              </Button>
              <Button
                variant="ai"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await assembleToDraft(chapterNumber)
                    setAssemblePreview(null)
                    setNotice(t('dialogue.assembleDone'))
                  })
                }
              >
                {t('dialogue.assembleConfirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
