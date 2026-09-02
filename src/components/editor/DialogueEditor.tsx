/**
 * DialogueEditor — 对话创作模式的章节编辑器
 *
 * 左：场列表；中：对话流 + 控场输入；收场时蒸馏预览对照可改。
 * 汇稿把全部已收场正文写入草稿箱，之后走原生 修稿/定稿 流程。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, ListTree, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Send, Square, Trash2, Undo2 } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import { getModelSpeeds } from '../../services/stats-service'
import { useDialogueStream } from '../../stores/dialogue-stream-store'
import { useDraftStore } from '../../stores/draft-store'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import {
  assembleToDraft,
  commitScene,
  distillScene,
  ensureWorkingState,
  generateTurn,
  previewChapterBody,
  previewTurn,
} from '../../services/dialogue/dialogue-service'
import { shouldResetChapterWorkingState } from '../../services/dialogue/working-state-policy'
import ModScopeBar from './ModScopeBar'
import { resolveOptionCount, resolveOptionMaxChars } from '../../services/dialogue/option-hints'
import { parseOptionHints, splitProseAndState, stripProtocolLeak } from '../../services/dialogue/state-protocol'
import RequestMonitor from './RequestMonitor'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [goalDraft, setGoalDraft] = useState('')
  const [lineDraft, setLineDraft] = useState('')
  const multilineOn = useProjectStore((s) => s.currentProject?.novelConfig?.multilineMode) === 'summary'
  const bookOptionEnabled = useProjectStore((s) => s.currentProject?.novelConfig?.optionHintsEnabled) ?? false
  const bookOptionCount = useProjectStore((s) => s.currentProject?.novelConfig?.optionHintsCount) ?? 3
  const bookOptionMaxChars = useProjectStore((s) => s.currentProject?.novelConfig?.optionHintsMaxChars) ?? 24
  const [optionOverride, setOptionOverride] = useState<number | null>(() => {
    const raw = localStorage.getItem('vela-dialogue-option-count')
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  })
  const [optionCharsOverride, setOptionCharsOverride] = useState<number | null>(() => {
    const raw = localStorage.getItem('vela-dialogue-option-max-chars')
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  })
  const optionCount = resolveOptionCount({
    bookEnabled: bookOptionEnabled,
    bookCount: bookOptionCount,
    localOverride: optionOverride,
  })
  const optionMaxChars = resolveOptionMaxChars({
    bookMaxChars: bookOptionMaxChars,
    localOverride: optionCharsOverride,
  })
  // 流式态提到 store（按场 id），切页签卸载重挂后能接着显示
  const stream = useDialogueStream()
  const session = sceneId != null ? stream.sessions[sceneId] : undefined
  const doneTick = sceneId != null ? stream.doneTick[sceneId] : undefined
  const streaming = session?.phase === 'generating' ? session.streaming : ''
  const distillDraft = session?.distillDraft ?? null
  const activeRequestId = session?.requestId ?? null
  const streamBusy = session?.phase != null
  // 首字未到期间每秒刷新一次渲染，等待提示能显示已等待秒数
  const waitingFirstByte =
    (session?.phase === 'generating' && !session.streaming) ||
    (session?.phase === 'distilling' && session.distillDraft === '')
  const [, bumpWaitTick] = useState(0)
  useEffect(() => {
    if (!waitingFirstByte) return
    const timer = setInterval(() => bumpWaitTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [waitingFirstByte])
  const waitedSeconds = session?.startedAt != null ? Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000)) : 0
  // 各模型近期平均耗时（选蒸馏模型时的速度参考），空闲时刷新
  const [modelSpeeds, setModelSpeeds] = useState<Record<string, number>>({})
  useEffect(() => {
    if (streamBusy) return
    void getModelSpeeds().then(setModelSpeeds)
  }, [streamBusy])
  // 蒸馏专用模型（'' = 跟随默认生成模型），本机记忆
  const [distillModelId, setDistillModelId] = useState(() => localStorage.getItem('vela-distill-model') ?? '')
  // 每轮目标字数（0 = 不限），本机记忆
  const [turnLength, setTurnLength] = useState(() => Number(localStorage.getItem('vela-dialogue-turn-length')) || 0)
  // 蒸馏目标字数（0 = 忠实草稿体量），本机记忆
  const [distillLength, setDistillLength] = useState(() => Number(localStorage.getItem('vela-distill-length')) || 0)
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
  const [requestOpen, setRequestOpen] = useState(
    () => localStorage.getItem('vela-dialogue-request-monitor') === 'open'
  )
  const toggleRequestMonitor = () => {
    setRequestOpen((prev) => {
      localStorage.setItem('vela-dialogue-request-monitor', prev ? 'closed' : 'open')
      return !prev
    })
  }
  const openRequestMonitor = () => {
    localStorage.setItem('vela-dialogue-request-monitor', 'open')
    setRequestOpen(true)
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const genAbortRef = useRef<AbortController | null>(null)
  // 是否贴底：用户上滑阅读时置 false，暂停自动跟随；滑回底部再恢复
  const stickToBottom = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const scene = scenes.find((s) => s.id === sceneId) ?? null

  const loadScenes = useCallback(async () => {
    const items = await ipc.invoke('db:scene-list', chapterNumber)
    setScenes(items)
    return items
  }, [chapterNumber])

  const refreshWorkingState = useCallback(async (sceneCount: number) => {
    if (shouldResetChapterWorkingState(sceneCount)) {
      await ipc.invoke('db:chapter-working-state-set', chapterNumber, {})
      setWorkingState(await ensureWorkingState(chapterNumber))
      return
    }
    setWorkingState(await ipc.invoke('db:chapter-working-state-get', chapterNumber))
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
      await refreshWorkingState(items.length)
    })()
  }, [chapterNumber, loadScenes, refreshWorkingState])

  useEffect(() => {
    setError('')
    if (sceneId == null) {
      setTurns([])
      return
    }
    void ipc.invoke('db:scene-turn-list', sceneId).then(setTurns)
  }, [sceneId])

  // 生成完成（可能发生在本编辑器被卸载期间）后从数据库重载回合与进行中状态
  useEffect(() => {
    if (sceneId == null || doneTick == null) return
    void ipc.invoke('db:scene-turn-list', sceneId).then(setTurns)
    void ipc.invoke('db:chapter-working-state-get', chapterNumber).then(setWorkingState)
  }, [doneTick, sceneId, chapterNumber])

  // 切场时同步场目标与线名草稿
  useEffect(() => {
    setGoalDraft(scene?.goal ?? '')
    setLineDraft(scene?.line ?? '')
  }, [scene?.id, scene?.goal, scene?.line])

  const saveGoal = () => {
    if (!scene || goalDraft === scene.goal) return
    void ipc.invoke('db:scene-update', scene.id, { goal: goalDraft.trim() }).then(() => loadScenes())
  }

  const saveWorkingState = (next: WorkingState) => {
    setWorkingState(next)
    void ipc.invoke('db:chapter-working-state-set', chapterNumber, next)
  }

  useEffect(() => {
    if (stickToBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, streaming])

  // 切场时重置为贴底
  useEffect(() => {
    stickToBottom.current = true
  }, [sceneId])

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
    const sid = scene.id
    const text = input.trim()
    if (!retry && !text) return
    setError('')
    genAbortRef.current?.abort()
    const ac = new AbortController()
    genAbortRef.current = ac
    stream.beginGenerate(sid)
    void generateTurn({
      scene,
      chapterTitle,
      chapterGoal,
      userInput: text,
      retry,
      targetLength: turnLength || undefined,
      optionCount: optionCount || undefined,
      optionMaxChars: optionCount ? optionMaxChars : undefined,
      signal: ac.signal,
      callbacks: {
        onChunk: (chunk) => stream.appendStreaming(sid, chunk),
        onRequest: (requestId) => stream.setRequest(sid, requestId || null),
        onRoundEnd: (proseSoFar) => stream.setStreaming(sid, proseSoFar + '\n\n'),
        onDone: () => {
          stream.finishGenerate(sid)
          if (!retry) setInput('')
        },
        onError: (msg) => {
          stream.fail(sid)
          setError(msg)
        },
      },
    }).then((requestId) => {
      if (ac.signal.aborted) return
      stream.setRequest(sid, requestId || null)
    }).catch((err) => {
      stream.fail(sid)
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const handlePreviewRequest = () => {
    if (!scene) return
    const text = input.trim()
    const retry = !text && turns[turns.length - 1]?.role === 'user'
    if (!text && !retry) return
    setError('')
    openRequestMonitor()
    void previewTurn({
      scene,
      chapterTitle,
      chapterGoal,
      userInput: text,
      retry,
      targetLength: turnLength || undefined,
      optionCount: optionCount || undefined,
      optionMaxChars: optionCount ? optionMaxChars : undefined,
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleStop = () => {
    if (!scene) return
    genAbortRef.current?.abort()
    genAbortRef.current = null
    if (activeRequestId) void useLLMStore.getState().cancelGeneration(activeRequestId)
    stream.fail(scene.id, session?.phase === 'distilling')
    setError(t('dialogue.stopped'))
  }

  // 蒸馏（流式）：草稿区实时增长，完成后替换为剥离状态块的干净稿
  const handleDistill = () => {
    if (!scene) return
    const sid = scene.id
    setError('')
    genAbortRef.current?.abort()
    const ac = new AbortController()
    genAbortRef.current = ac
    stream.beginDistill(sid)
    void distillScene({
      scene,
      chapterTitle,
      chapterGoal,
      modelId: distillModelId || undefined,
      targetLength: distillLength || undefined,
      signal: ac.signal,
      callbacks: {
        onChunk: (chunk) => stream.appendDistill(sid, chunk),
        onDone: (draft) => stream.finishDistill(sid, draft),
        onError: (msg) => {
          stream.fail(sid)
          setError(msg)
        },
      },
    })
      .then((requestId) => {
        if (ac.signal.aborted) return
        stream.setRequest(sid, requestId || null)
      })
      .catch((err) => {
        stream.fail(sid)
        setError(err instanceof Error ? err.message : String(err))
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
    const cuts = [raw.search(/<state>/i), raw.search(/<options>/i)].filter((i) => i >= 0)
    const cut = cuts.length ? Math.min(...cuts) : -1
    return stripProtocolLeak((cut === -1 ? raw : raw.slice(0, cut)).trimEnd())
  }
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
  const optionHints =
    optionCount > 0 && lastAssistant && !streamBusy
      ? parseOptionHints(lastAssistant.content, optionCount)
      : []

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
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
              {s.line && (
                <span
                  className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[0.58rem]"
                  style={{ color: 'var(--color-accent)', backgroundColor: 'var(--color-active)' }}
                >
                  {s.line}
                </span>
              )}
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
                      await refreshWorkingState(items.length)
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
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
        <div className="panel-header justify-between">
          <span className="truncate">
            {projectName} · {chapterTitle}
            {scene ? ` · ${scene.title || `场${scene.seq}`}` : ''}
          </span>
          <div className="flex flex-shrink-0 items-center gap-2">
            {scene && (
              <span className="text-[0.68rem] normal-case" style={{ color: 'var(--color-text-muted)' }}>
                {t('dialogue.turnCount', { n: turns.filter((x) => x.role === 'assistant').length })}
              </span>
            )}
            <button
              className="icon-btn hidden xl:flex"
              title={t('dialogue.workingState')}
              onClick={toggleStatePanel}
            >
              {statePanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          </div>
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
              {multilineOn && (
                <>
                  <span className="flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {t('dialogue.sceneLine')}
                  </span>
                  <Input
                    className="w-32 flex-shrink-0"
                    value={lineDraft}
                    onChange={(e) => setLineDraft(e.target.value)}
                    onBlur={() => {
                      if (scene && lineDraft !== (scene.line ?? '')) {
                        void ipc.invoke('db:scene-update', scene.id, { line: lineDraft.trim() }).then(() => loadScenes())
                      }
                    }}
                    placeholder={t('dialogue.sceneLinePlaceholder')}
                  />
                </>
              )}
            </div>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 pb-10">
              {turns.map((turn) => (
                <div key={turn.id} className={turn.role === 'user' ? 'text-right' : 'text-left'}>
                  <div
                    className={`inline-block whitespace-pre-wrap rounded-xl px-4 py-2.5 text-left text-sm leading-7 ${
                      turn.role === 'assistant' ? 'w-full max-w-none' : 'max-w-[90%]'
                    }`}
                    style={{
                      backgroundColor:
                        turn.role === 'user' ? 'var(--color-active)' : 'var(--color-sidebar)',
                      fontFamily: turn.role === 'assistant' ? 'var(--font-writing)' : undefined,
                    }}
                  >
                    {turn.role === 'assistant' ? splitProseAndState(turn.content).prose : turn.content}
                  </div>
                </div>
              ))}
              {session?.phase === 'generating' && (
                <div className="text-left">
                  <div
                    className="inline-block w-full max-w-none whitespace-pre-wrap rounded-xl px-4 py-2.5 text-sm leading-7"
                    style={{ backgroundColor: 'var(--color-sidebar)', fontFamily: 'var(--font-writing)' }}
                  >
                    {liveProse(streaming) || (
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        {t('dialogue.waitingModel', { s: waitedSeconds })}
                      </span>
                    )}
                    <span className="ai-stream-cursor" />
                  </div>
                </div>
              )}
              {optionHints.length > 0 && scene.status === 'open' && (
                <div className="space-y-1.5">
                  <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {t('dialogue.optionHintsLabel')}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {optionHints.map((hint, i) => (
                      <button
                        key={`${i}-${hint}`}
                        className="rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-accent)] hover:text-white"
                        style={{
                          border: '1px solid var(--color-border)',
                          backgroundColor: 'var(--color-hover)',
                          color: 'var(--color-text-secondary)',
                        }}
                        disabled={busy || streamBusy}
                        onClick={() => setInput(hint)}
                      >
                        {i + 1}. {hint}
                      </button>
                    ))}
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
                    placeholder={session?.phase === 'distilling' ? t('dialogue.waitingModel', { s: waitedSeconds }) : undefined}
                    disabled={busy || streamBusy}
                    onChange={(e) => sceneId != null && stream.setDistillDraft(sceneId, e.target.value)}
                  />
                </div>
              )}
              {scene.status === 'distilled' && scene.body && (
                <div
                  className="rounded-xl p-3"
                  style={{ border: '1px solid var(--color-success)', backgroundColor: 'var(--color-sidebar)' }}
                >
                  <div className="mb-1 flex items-center justify-between text-xs" style={{ color: 'var(--color-success)' }}>
                    <span>{t('dialogue.committedHint')}</span>
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {t('dialogue.wordCount', { n: scene.body.replace(/\s/g, '').length })}
                    </span>
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
            {requestOpen && (
              <div
                className="flex h-36 flex-shrink-0 flex-col overflow-hidden"
                style={{
                  borderTop: '1px solid var(--color-border)',
                  backgroundColor: 'var(--color-panel, var(--color-editor-bg))',
                }}
              >
                <RequestMonitor chapterNumber={chapterNumber} sceneId={sceneId ?? undefined} />
              </div>
            )}
            <div className="flex-shrink-0 space-y-2 p-3" style={{ borderTop: '1px solid var(--color-border)' }}>
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
                      disabled={busy || streamBusy}
                      onClick={() => setInput((prev) => (prev.trim() ? `${prev} ${preset}` : preset))}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              )}
              <ModScopeBar chapterNumber={chapterNumber} sceneId={scene?.id} />
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
                  disabled={busy || streamBusy || !input.trim() || scene.status !== 'open'}
                  onClick={() => handleGenerate(false)}
                >
                  <Send size={12} /> {t('dialogue.send')}
                </Button>
                <NativeSelect
                  className="w-28"
                  title={t('dialogue.turnLengthTooltip')}
                  value={String(turnLength)}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setTurnLength(v)
                    localStorage.setItem('vela-dialogue-turn-length', String(v))
                  }}
                >
                  <option value="0">{t('dialogue.turnLengthFree')}</option>
                  {[300, 500, 800, 1200, 2000].map((n) => (
                    <option key={n} value={n}>
                      {t('dialogue.turnLengthOption', { n })}
                    </option>
                  ))}
                </NativeSelect>
                {bookOptionEnabled && (
                  <NativeSelect
                    className="w-36"
                    title={t('dialogue.optionHintsTooltip')}
                    value={optionOverride == null ? '' : String(optionOverride)}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw === '') {
                        setOptionOverride(null)
                        localStorage.setItem('vela-dialogue-option-count', '')
                        return
                      }
                      const v = Number(raw)
                      setOptionOverride(v)
                      localStorage.setItem('vela-dialogue-option-count', String(v))
                    }}
                  >
                    <option value="">{t('dialogue.optionHintsInherit')}</option>
                    <option value="0">{t('dialogue.optionHintsOff')}</option>
                    {[3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {t('dialogue.optionHintsCountLive', { n })}
                      </option>
                    ))}
                  </NativeSelect>
                )}
                {optionCount > 0 && (
                  <NativeSelect
                    className="w-36"
                    title={t('dialogue.optionHintsCharsTooltip')}
                    value={optionCharsOverride == null ? '' : String(optionCharsOverride)}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw === '') {
                        setOptionCharsOverride(null)
                        localStorage.setItem('vela-dialogue-option-max-chars', '')
                        return
                      }
                      const v = Number(raw)
                      setOptionCharsOverride(v)
                      localStorage.setItem('vela-dialogue-option-max-chars', String(v))
                    }}
                  >
                    <option value="">{t('dialogue.optionHintsCharsInherit')}</option>
                    <option value="0">{t('dialogue.optionHintsCharsFree')}</option>
                    {[12, 16, 24, 32, 40, 50].map((n) => (
                      <option key={n} value={n}>
                        {t('dialogue.optionHintsCharsLive', { n })}
                      </option>
                    ))}
                  </NativeSelect>
                )}
                {streamBusy && (
                  <Button variant="destructive" size="sm" onClick={handleStop}>
                    <Square size={12} /> {t('dialogue.stop')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    busy || streamBusy || scene.status !== 'open' || turns[turns.length - 1]?.role !== 'user'
                  }
                  onClick={() => handleGenerate(true)}
                >
                  <RefreshCw size={12} /> {t('dialogue.retry')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || streamBusy || scene.status !== 'open' || turns.length === 0}
                  title={t('dialogue.undoTurnTooltip')}
                  onClick={handleUndoTurn}
                >
                  <Undo2 size={12} /> {t('dialogue.undoTurn')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    busy ||
                    streamBusy ||
                    scene.status !== 'open' ||
                    (!input.trim() && turns[turns.length - 1]?.role !== 'user')
                  }
                  title={t('dialogue.requestPreviewTooltip')}
                  onClick={handlePreviewRequest}
                >
                  <ListTree size={12} /> {t('dialogue.requestPreview')}
                </Button>
                <Button
                  variant={requestOpen ? 'outline' : 'ghost'}
                  size="sm"
                  title={t('dialogue.requestMonitorTitle')}
                  onClick={toggleRequestMonitor}
                >
                  <Eye size={12} /> {t('dialogue.requestMonitor')}
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
                            {modelSpeeds[m.id]
                              ? t('dialogue.modelAvgSpeed', { s: Math.max(1, Math.round(modelSpeeds[m.id] / 1000)) })
                              : ''}
                          </option>
                        ))}
                    </NativeSelect>
                    <NativeSelect
                      className="w-32"
                      title={t('dialogue.distillLengthTooltip')}
                      value={String(distillLength)}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setDistillLength(v)
                        localStorage.setItem('vela-distill-length', String(v))
                      }}
                    >
                      <option value="0">{t('dialogue.distillLengthFree')}</option>
                      {[1000, 2000, 3000, 4000, 6000].map((n) => (
                        <option key={n} value={n}>
                          {t('dialogue.distillLengthOption', { n })}
                        </option>
                      ))}
                    </NativeSelect>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || streamBusy || turns.length === 0}
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
                      disabled={busy || streamBusy || !distillDraft.trim()}
                      onClick={() =>
                        void run(async () => {
                          await commitScene(scene, distillDraft.trim())
                          stream.setDistillDraft(scene.id, null)
                          await loadScenes()
                        })
                      }
                    >
                      {t('dialogue.commit')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy || streamBusy} onClick={handleDistill}>
                      {t('dialogue.redistill')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || streamBusy}
                      onClick={() => sceneId != null && stream.setDistillDraft(sceneId, null)}
                    >
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
          {Object.entries(workingState).map(([name, fields]) => {
            // 标准六字段始终显示（空值也给输入框，便于手动补），模型自创字段附加在后
            const STANDARD = ['location', 'physicalState', 'mentalState', 'keyItems', 'recentEvents', 'knownInfo']
            const keys = [...STANDARD, ...Object.keys(fields).filter((k) => !STANDARD.includes(k))]
            return (
            <div
              key={name}
              className="rounded-lg p-2"
              style={{ border: '1px solid var(--color-border)' }}
            >
              <div className="mb-1 text-xs font-semibold">{name}</div>
              {keys.map((k) => {
                const v = fields[k] ?? ''
                return (
                <label key={k} className="mb-1 block text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                  {t(`dialogue.stateFields.${k}`, { defaultValue: k })}
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
                )
              })}
            </div>
            )
          })}
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
                    // 刷新侧栏草稿箱，否则新草稿不可见
                    await useDraftStore.getState().loadAllDrafts()
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
