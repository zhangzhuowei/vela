/**
 * 对话创作模式 — 渲染端服务
 *
 * 生成走 llm-store.generateStream（与写稿命令同一条 LLM 通道）；
 * 数据读写走 db:scene-* IPC。蒸馏失败不落库；汇稿写入草稿箱。
 */
import { ipc } from '../ipc-client'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import { useCharacterStore } from '../../stores/character-store'
import type { WorkingState } from '../../shared/ipc-channels'
import type { SceneData, SceneTurnData } from '../../../electron/repositories/scene-repository'
import {
  buildDistillMessages,
  buildSceneMessages,
  composeDialoguePostHistory,
  dialogueFormatContract,
  pinPostHistory,
  type ChatMessage,
  type DialogueCharacter,
  type DialogueConfig,
  type KnowledgeRef,
} from './dialogue-prompts'
import { formatOptionHints, mergeWorkingState, parseOptionHints, splitProseAndState } from './state-protocol'
import { assembleChapterBody } from './assemble'
import { selectSceneCharacters } from './select-characters'
import { getPromptTemplate, renderPrompt } from '../prompt-templates'
import { logLLMCall } from '../stats-service'
import { runWithModScopeAsync } from '../mods'
import { buildScenePrelude, resolveScenePreludeMode } from './scene-prelude'
import { loadSettingDigest } from '../setting-bible-service'
import { allocateKbHits, kbOverfetch } from '../kb-allocate'

type LLMUsage = { promptTokens: number; completionTokens: number; totalTokens: number }

/** 正文不足目标八成且未达续写上限时自动再开一轮。 */
export function shouldContinueTurn(
  written: number,
  target: number | undefined,
  rounds: number,
  maxContinuations = 2
): boolean {
  return Boolean(target && written < target * 0.8 && rounds < maxContinuations)
}

/** 对话模式的调用也记入 llm_calls，与写稿管线共用「模型调用」面板 */
function logDialogueCall(
  purpose: string,
  modelId: string | undefined,
  startedAt: number,
  usage?: LLMUsage,
  errorMessage?: string
): void {
  const st = useLLMStore.getState()
  const mid = modelId ?? st.defaultModelId ?? ''
  const model = st.models.find((m) => m.id === mid)
  void logLLMCall({
    modelId: mid,
    modelName: model?.name ?? mid,
    purpose,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    durationMs: Date.now() - startedAt,
    success: !errorMessage,
    errorMessage,
  })
}

/**
 * 组装对话配置。配置种子字段（world_setting / protagonist_profile）为空时
 * 回退到架构四大件与主角角色卡——很多工程只填了 AI 生成的架构。
 */
async function fetchConfig(): Promise<DialogueConfig> {
  const cfg = useProjectStore.getState().currentProject?.novelConfig
  let worldSetting = cfg?.worldSetting?.trim() || ''
  let protagonistProfile = cfg?.protagonistProfile?.trim() || ''
  if (!worldSetting || !protagonistProfile) {
    const core = await ipc.invoke('db:project-core-get')
    if (!worldSetting) {
      worldSetting = (core?.worldbuilding || core?.premise || '').trim().slice(0, 1500)
    }
    if (!protagonistProfile) {
      const hero = useCharacterStore.getState().characters.find((c) => c.role === 'protagonist')
      if (hero) {
        protagonistProfile = [
          hero.name,
          hero.personality && `性格：${hero.personality}`,
          hero.background && `背景：${hero.background}`,
          hero.motivation && `动机：${hero.motivation}`,
        ]
          .filter(Boolean)
          .join('；')
          .slice(0, 800)
      }
    }
  }
  const { getActiveModSystemGuidance } = await import('../mods')
  return {
    worldSetting,
    protagonistProfile,
    globalGuidance: [cfg?.globalGuidance, getActiveModSystemGuidance()].filter(Boolean).join('\n\n'),
    writingStyle: cfg?.writingStyle,
  }
}

/** 当前工程启用 Mod 的贴底段；空串表示不钉 */
async function fetchModPostHistory(): Promise<string> {
  const { getActiveModGuidance } = await import('../mods')
  return getActiveModGuidance()
}

/** 本场出场角色（主角 + 蓝图出场表 + 有进行中状态者，截断防爆上下文） */
async function sceneCharacters(
  chapterNumber: number,
  workingState: WorkingState
): Promise<DialogueCharacter[]> {
  const blueprint = await ipc.invoke('db:blueprint-get', chapterNumber)
  const picked = selectSceneCharacters({
    all: useCharacterStore.getState().characters,
    blueprintCast: blueprint?.characters ?? [],
    workingState,
  })
  return picked.map((c) => ({
    name: c.name,
    personality: c.personality,
    appearance: c.appearance,
    speechStyle: c.speechStyle,
    relationships: c.relationships,
    motivation: c.motivation,
  }))
}

/** 知识库召回（无向量模型/空库时静默降级为空）；多取后按设定 / 词表 / 其它分名额 */
async function retrieveReferences(query: string, topK = 4): Promise<KnowledgeRef[]> {
  const q = query.trim()
  if (!q) return []
  try {
    const results = await ipc.invoke('kb:search', q, kbOverfetch(topK))
    return allocateKbHits((results || []).filter((r) => r.text && r.text.trim()), topK)
      .map((r) => ({ fileName: r.fileName, text: r.text.trim().slice(0, 600) }))
  } catch {
    return []
  }
}

/** 解析章的有效创作模式：章级覆盖优先，其次工程默认 */
export async function resolveChapterMode(chapterNumber: number): Promise<'pipeline' | 'dialogue'> {
  const override = await ipc.invoke('db:chapter-mode-get', chapterNumber)
  if (override === 'pipeline' || override === 'dialogue') return override
  return useProjectStore.getState().currentProject?.novelConfig?.creationMode === 'dialogue'
    ? 'dialogue'
    : 'pipeline'
}

/** 本书是否启用多线「同线摘要」 */
function multilineSummaryOn(): boolean {
  return useProjectStore.getState().currentProject?.novelConfig?.multilineMode === 'summary'
}

/** 生成一场的前情摘要并写回 scenes.summary；失败静默返回空串（摘要缺失不阻塞创作） */
async function generateSceneSummary(sceneId: number, body: string): Promise<string> {
  const text = body.trim()
  if (!text) return ''
  const template = getPromptTemplate('dialogue_scene_summary')
  if (!template) return ''
  try {
    const messages = [{ role: 'system' as const, content: renderPrompt(template, { scene_body: text }) }]
    const modelId = localStorage.getItem('vela-distill-model') || undefined
    const t0 = Date.now()
    const res = await useLLMStore.getState().generate(messages, modelId)
    logDialogueCall('SceneSummary', modelId, t0, res.usage, res.success ? undefined : res.error)
    const summary = (res.success ? res.content : '').trim()
    if (summary) await ipc.invoke('db:scene-set-summary', sceneId, summary)
    return summary
  } catch {
    return ''
  }
}

/**
 * 多线联动：取同线上一场的前情摘要。
 * 正常路径下摘要已在收场时预生成好，直接复用；
 * 老数据没有摘要时兜底懒生成一次并缓存。
 * 关多线、无线名、无同线前场时返回空串。
 */
export async function getLineContext(scene: SceneData): Promise<string> {
  if (!multilineSummaryOn() || !scene.line) return ''
  const prev = await ipc.invoke('db:scene-prev-in-line', scene.chapterNumber, scene.line, scene.seq)
  if (!prev) return ''
  if (prev.summary && prev.summary.trim()) return prev.summary.trim()
  if (!prev.body || !prev.body.trim()) return ''
  return generateSceneSummary(prev.id, prev.body)
}

/**
 * 场间前情：按书级开关注入上一场结尾或本章已收场摘要。
 * 摘要优先复用收场时缓存；缺失则懒生成，失败时用正文开头顶一段。
 */
export async function getScenePrelude(scene: SceneData): Promise<string> {
  const mode = resolveScenePreludeMode(
    useProjectStore.getState().currentProject?.novelConfig?.scenePreludeMode,
  )
  if (mode === 'off') return ''
  const scenes = await ipc.invoke('db:scene-list', scene.chapterNumber)
  if (mode === 'chapter_summaries') {
    for (const s of scenes) {
      if (s.seq >= scene.seq || s.status !== 'distilled') continue
      if (s.summary.trim()) continue
      if (!s.body.trim()) continue
      s.summary = await generateSceneSummary(s.id, s.body)
    }
  }
  return buildScenePrelude({ mode, currentSeq: scene.seq, scenes })
}

/** 开章时若进行中状态为空，从角色卡当前状态拷贝一份作为起点 */
export async function ensureWorkingState(chapterNumber: number): Promise<WorkingState> {
  const existing = await ipc.invoke('db:chapter-working-state-get', chapterNumber)
  if (Object.keys(existing).length > 0) return existing
  const seeded: WorkingState = {}
  for (const c of useCharacterStore.getState().characters) {
    const st = c.currentState
    if (!st) continue
    const fields: Record<string, string> = {}
    if (st.location) fields.location = st.location
    if (st.physicalState) fields.physicalState = st.physicalState
    if (st.mentalState) fields.mentalState = st.mentalState
    if (st.keyItems) fields.keyItems = st.keyItems
    if (st.recentEvents) fields.recentEvents = st.recentEvents
    if (st.knownInfo) fields.knownInfo = st.knownInfo
    if (Object.keys(fields).length > 0) seeded[c.name] = fields
  }
  if (Object.keys(seeded).length > 0) {
    await ipc.invoke('db:chapter-working-state-set', chapterNumber, seeded)
  }
  return seeded
}

export type GenerateTurnCallbacks = {
  onChunk: (chunk: string) => void
  onDone: (turns: SceneTurnData[], workingState: WorkingState) => void
  onError: (error: string) => void
  /** 每一轮（含自动续写）拿到新的 requestId 时回调，供停止按钮跟踪 */
  onRequest?: (requestId: string) => void
  /** 一轮流结束、即将自动续写时回调：参数为目前已清洗的正文，供 UI 重置流式区 */
  onRoundEnd?: (proseSoFar: string) => void
}

export type AssembleTurnParams = {
  scene: SceneData
  chapterTitle: string
  chapterGoal: string
  userInput: string
  retry?: boolean
  /** 本轮目标字数（不传则不限） */
  targetLength?: number
  /** 本轮结束后给出的控场选项条数（不传则不要求） */
  optionCount?: number
  /** 每条选项字数上限（0 = 不限） */
  optionMaxChars?: number
  /** 停止按钮：中止后续续写与落库 */
  signal?: AbortSignal
}

/** 组装本轮 core + 贴底（不调模型）。续写必须用 skipFormat 的 core，格式只钉在最后。 */
export async function assembleTurnMessages(params: AssembleTurnParams): Promise<{
  core: ChatMessage[]
  postHistory: string
  workingState: WorkingState
  characters: DialogueCharacter[]
}> {
  const { scene } = params
  const turns = await ipc.invoke('db:scene-turn-list', scene.id)
  const workingState = await ensureWorkingState(scene.chapterNumber)
  const characters = await sceneCharacters(scene.chapterNumber, workingState)
  const lastUser = params.retry ? [...turns].reverse().find((t) => t.role === 'user')?.content : params.userInput
  const references = await retrieveReferences(
    [lastUser, scene.goal || scene.title, params.chapterGoal].filter(Boolean).join(' ')
  )
  const lineContext = await getLineContext(scene)
  const scenePrelude = await getScenePrelude(scene)
  const settingDigest = await loadSettingDigest({ chapterNumber: scene.chapterNumber, sceneId: scene.id })
  const target = params.targetLength
  const promptInput =
    !params.retry && target
      ? `${params.userInput.trim()}\n（本轮篇幅目标约 ${target} 字，硬性下限 ${Math.round(target * 0.8)} 字，写满为止）`
      : params.userInput
  const scope = { chapterNumber: scene.chapterNumber, sceneId: scene.id }
  return runWithModScopeAsync(scope, async () => {
    const postHistory = composeDialoguePostHistory(
      await fetchModPostHistory(),
      dialogueFormatContract(params.optionCount, params.optionMaxChars)
    )
    const core = buildSceneMessages({
      config: await fetchConfig(),
      characters,
      workingState,
      chapterTitle: params.chapterTitle,
      chapterGoal: params.chapterGoal,
      sceneTitle: scene.title,
      sceneGoal: scene.goal,
      lineContext,
      scenePrelude,
      turns: turns.map((t) => ({ role: t.role, content: splitProseAndState(t.content).prose })),
      userInput: params.retry ? undefined : promptInput,
      references,
      settingDigest,
      targetLength: target,
      optionCount: params.optionCount,
      optionMaxChars: params.optionMaxChars,
      skipFormat: true,
    })
    return { core, postHistory, workingState, characters }
  })
}

/** 只组装并发一条监控快照，不调用模型。 */
export async function previewTurn(params: AssembleTurnParams): Promise<ChatMessage[]> {
  const { core, postHistory } = await assembleTurnMessages(params)
  const messages = pinPostHistory(core, postHistory)
  useLLMStore.getState().recordTrace({ modelId: 'preview', stream: false, messages })
  return messages
}

/**
 * 场内生成一轮：控场指令 → 模型正文 + 状态补丁。
 * 成功后 user/assistant 两条回合与合并后的章状态一起落库。
 * retry=true 时不追加新 user（沿用现有历史，最后一条应为 user）。
 */
export async function generateTurn(
  params: AssembleTurnParams & { callbacks: GenerateTurnCallbacks }
): Promise<string> {
  const { scene, callbacks } = params
  const abandoned = () => Boolean(params.signal?.aborted)
  const { core: coreMessages, postHistory, workingState, characters } = await assembleTurnMessages(params)
  if (abandoned()) {
    callbacks.onError('已取消生成')
    return ''
  }

  // 篇幅闸门：正文不足目标八成时自动续写（最多 2 轮），与写稿链路同款策略
  const MAX_CONTINUATIONS = 2
  const target = params.targetLength
  const parts: { prose: string; patch: WorkingState; options: string[] }[] = []
  let rounds = 0

  const totalProse = () => parts.map((p) => p.prose).join('\n\n')
  const countChars = (s: string) => s.replace(/\s/g, '').length

  const finalize = async () => {
    if (abandoned()) {
      callbacks.onError('已取消生成')
      return
    }
    try {
      const prose = totalProse().trim()
      if (!prose) {
        callbacks.onError('模型没有写出正文')
        return
      }
      // 各轮补丁按顺序合并（后轮覆盖同字段）
      const validNames = characters.map((c) => c.name)
      let nextState = workingState
      let mergedPatch: WorkingState = {}
      for (const part of parts) {
        nextState = mergeWorkingState(nextState, part.patch, validNames)
        mergedPatch = { ...mergedPatch, ...part.patch }
      }
      const lastOptions = parts[parts.length - 1]?.options ?? []
      const saved = lastOptions.length ? `${prose}\n\n${formatOptionHints(lastOptions)}` : prose
      if (!params.retry && params.userInput.trim()) {
        await ipc.invoke('db:scene-turn-add', scene.id, 'user', params.userInput.trim())
      }
      await ipc.invoke('db:scene-turn-add', scene.id, 'assistant', saved, mergedPatch)
      await ipc.invoke('db:chapter-working-state-set', scene.chapterNumber, nextState)
      const refreshed = await ipc.invoke('db:scene-turn-list', scene.id)
      callbacks.onDone(refreshed, nextState)
    } catch (err) {
      callbacks.onError(String(err))
    }
  }

  const runRound = (coreMsgs: ChatMessage[]): Promise<string> => {
    const t0 = Date.now()
    return useLLMStore.getState().generateStream(pinPostHistory(coreMsgs, postHistory), {
      onChunk: callbacks.onChunk,
      onDone: (fullText, usage) => {
        logDialogueCall('DialogueTurn', undefined, t0, usage)
        if (abandoned()) {
          callbacks.onError('已取消生成')
          return
        }
        void (async () => {
          try {
            if (abandoned()) {
              callbacks.onError('已取消生成')
              return
            }
            const { prose, patch } = splitProseAndState(fullText)
            const options = parseOptionHints(fullText, params.optionCount)
            if (prose) parts.push({ prose, patch, options })
            const written = countChars(totalProse())
            if (target && prose && shouldContinueTurn(written, target, rounds, MAX_CONTINUATIONS) && !abandoned()) {
              rounds++
              callbacks.onRoundEnd?.(totalProse())
              const contMsgs = [
                ...coreMsgs,
                { role: 'assistant' as const, content: fullText },
                {
                  role: 'user' as const,
                  content:
                    `目前正文共约 ${written} 字，尚未达到本轮目标（约 ${target} 字，硬性下限 ${Math.round(target * 0.8)} 字）。` +
                    '继续写下去补足篇幅：无缝衔接上文，不要重复已写内容、不要总结、不要重新开头；写完后同样输出 <state> 状态块（只含相对最新状态的变化）。',
                },
              ]
              const rid = await runRound(contMsgs)
              callbacks.onRequest?.(rid)
              return
            }
            await finalize()
          } catch (err) {
            callbacks.onError(String(err))
          }
        })()
      },
      onError: (error) => {
        logDialogueCall('DialogueTurn', undefined, t0, undefined, error)
        callbacks.onError(error)
      },
    })
  }

  const requestId = await runRound(coreMessages)
  callbacks.onRequest?.(requestId)
  return requestId
}

export type DistillCallbacks = {
  onChunk: (chunk: string) => void
  onDone: (draft: string) => void
  onError: (error: string) => void
}

/**
 * 收场蒸馏（流式）：返回 requestId 供取消；草稿经 onDone 交付，不落库
 * （由调用方确认后 commitScene）。modelId 缺省用默认生成模型。
 */
export async function distillScene(params: {
  scene: SceneData
  chapterTitle: string
  chapterGoal: string
  modelId?: string
  /** 蒸馏目标字数（不传则忠实草稿体量） */
  targetLength?: number
  signal?: AbortSignal
  callbacks: DistillCallbacks
}): Promise<string> {
  const { callbacks } = params
  if (params.signal?.aborted) {
    callbacks.onError('已取消生成')
    return ''
  }
  const turns = await ipc.invoke('db:scene-turn-list', params.scene.id)
  if (turns.length === 0) throw new Error('本场还没有对话，不能收场')
  const references = await retrieveReferences(
    [params.scene.goal || params.scene.title, params.chapterGoal, turns[0]?.content].filter(Boolean).join(' ')
  )
  const workingState = await ipc.invoke('db:chapter-working-state-get', params.scene.chapterNumber)
  const cast = await sceneCharacters(params.scene.chapterNumber, workingState)
  const settingDigest = await loadSettingDigest({ chapterNumber: params.scene.chapterNumber, sceneId: params.scene.id })
  const messages = await runWithModScopeAsync(
    { chapterNumber: params.scene.chapterNumber, sceneId: params.scene.id },
    async () =>
      buildDistillMessages({
        config: await fetchConfig(),
        characterNames: cast.map((c) => c.name),
        chapterTitle: params.chapterTitle,
        chapterGoal: params.chapterGoal,
        sceneTitle: params.scene.title,
        sceneGoal: params.scene.goal,
        turns: turns.map((t) => ({ role: t.role, content: t.content })),
        references,
        settingDigest,
        targetLength: params.targetLength,
        postHistory: await fetchModPostHistory(),
      })
  )
  const t0 = Date.now()
  return useLLMStore.getState().generateStream(
    messages,
    {
      onChunk: callbacks.onChunk,
      onDone: (fullText, usage) => {
        try {
          logDialogueCall('DialogueDistill', params.modelId, t0, usage)
          if (params.signal?.aborted) {
            callbacks.onError('已取消生成')
            return
          }
          const { prose } = splitProseAndState(fullText)
          if (!prose.trim()) {
            callbacks.onError('蒸馏没有写出正文')
            return
          }
          callbacks.onDone(prose.trim())
        } catch (err) {
          callbacks.onError(String(err))
        }
      },
      onError: (error) => {
        logDialogueCall('DialogueDistill', params.modelId, t0, undefined, error)
        callbacks.onError(error)
      },
    },
    params.modelId
  )
}

/** 收场落盘；需要摘要的开关打开时后台预生成（下一场直接复用） */
export async function commitScene(scene: SceneData, body: string): Promise<void> {
  const res = await ipc.invoke('db:scene-commit', scene.id, body)
  if (!res.success) throw new Error(res.error || '收场失败')
  const preludeMode = resolveScenePreludeMode(
    useProjectStore.getState().currentProject?.novelConfig?.scenePreludeMode,
  )
  if ((multilineSummaryOn() && scene.line) || preludeMode === 'chapter_summaries') {
    void generateSceneSummary(scene.id, body)
  }
}

/** 汇稿预览：拼接本章全部已收场正文，只读不落库 */
export async function previewChapterBody(chapterNumber: number): Promise<string> {
  const scenes = await ipc.invoke('db:scene-list', chapterNumber)
  return assembleChapterBody(scenes)
}

/** 汇稿：本章全部已收场正文拼接后写入草稿箱，返回新草稿 id */
export async function assembleToDraft(chapterNumber: number): Promise<number> {
  const scenes = await ipc.invoke('db:scene-list', chapterNumber)
  const body = assembleChapterBody(scenes)
  const version = await ipc.invoke('db:draft-next-version', chapterNumber)
  const res = await ipc.invoke('db:draft-create', {
    chapterNumber,
    version,
    source: 'write',
    content: body,
    wordCount: body.replace(/\s/g, '').length,
  })
  if (!res.success || !res.id) throw new Error(res.error || '写入草稿箱失败')
  return res.id
}
