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
  type DialogueCharacter,
  type DialogueConfig,
  type KnowledgeRef,
} from './dialogue-prompts'
import { mergeWorkingState, splitProseAndState } from './state-protocol'
import { assembleChapterBody } from './assemble'
import { selectSceneCharacters } from './select-characters'

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
  // 启用的 Mod 行文指导追加段（按书叠加）
  const { getActiveModGuidance } = await import('../mods')
  const modGuidance = getActiveModGuidance()
  return {
    worldSetting,
    protagonistProfile,
    globalGuidance: [cfg?.globalGuidance, modGuidance].filter(Boolean).join('\n\n'),
    writingStyle: cfg?.writingStyle,
  }
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

/** 知识库召回（无向量模型/空库时静默降级为空） */
async function retrieveReferences(query: string, topK = 4): Promise<KnowledgeRef[]> {
  const q = query.trim()
  if (!q) return []
  try {
    const results = await ipc.invoke('kb:search', q, topK)
    return (results || [])
      .filter((r) => r.text && r.text.trim())
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
}

/**
 * 场内生成一轮：控场指令 → 模型正文 + 状态补丁。
 * 成功后 user/assistant 两条回合与合并后的章状态一起落库。
 * retry=true 时不追加新 user（沿用现有历史，最后一条应为 user）。
 */
export async function generateTurn(params: {
  scene: SceneData
  chapterTitle: string
  chapterGoal: string
  userInput: string
  retry?: boolean
  callbacks: GenerateTurnCallbacks
}): Promise<string> {
  const { scene, callbacks } = params
  const turns = await ipc.invoke('db:scene-turn-list', scene.id)
  const workingState = await ensureWorkingState(scene.chapterNumber)
  const characters = await sceneCharacters(scene.chapterNumber, workingState)
  // 召回 query：控场指令优先，其次场/章目标
  const lastUser = params.retry ? [...turns].reverse().find((t) => t.role === 'user')?.content : params.userInput
  const references = await retrieveReferences(
    [lastUser, scene.goal || scene.title, params.chapterGoal].filter(Boolean).join(' ')
  )

  const messages = buildSceneMessages({
    config: await fetchConfig(),
    characters,
    workingState,
    chapterTitle: params.chapterTitle,
    chapterGoal: params.chapterGoal,
    sceneTitle: scene.title,
    sceneGoal: scene.goal,
    turns: turns.map((t) => ({ role: t.role, content: t.content })),
    userInput: params.retry ? undefined : params.userInput,
    references,
  })

  return useLLMStore.getState().generateStream(messages, {
    onChunk: callbacks.onChunk,
    onDone: (fullText) => {
      void (async () => {
        try {
          const { prose, patch } = splitProseAndState(fullText)
          if (!prose) {
            callbacks.onError('模型没有写出正文')
            return
          }
          const validNames = characters.map((c) => c.name)
          const nextState = mergeWorkingState(workingState, patch, validNames)
          if (!params.retry && params.userInput.trim()) {
            await ipc.invoke('db:scene-turn-add', scene.id, 'user', params.userInput.trim())
          }
          await ipc.invoke('db:scene-turn-add', scene.id, 'assistant', prose, patch)
          await ipc.invoke('db:chapter-working-state-set', scene.chapterNumber, nextState)
          const refreshed = await ipc.invoke('db:scene-turn-list', scene.id)
          callbacks.onDone(refreshed, nextState)
        } catch (err) {
          callbacks.onError(String(err))
        }
      })()
    },
    onError: callbacks.onError,
  })
}

/** 收场蒸馏：返回草稿文本，不落库（由调用方确认后 commitScene） */
export async function distillScene(params: {
  scene: SceneData
  chapterTitle: string
  chapterGoal: string
}): Promise<string> {
  const turns = await ipc.invoke('db:scene-turn-list', params.scene.id)
  if (turns.length === 0) throw new Error('本场还没有对话，不能收场')
  const references = await retrieveReferences(
    [params.scene.goal || params.scene.title, params.chapterGoal, turns[0]?.content].filter(Boolean).join(' ')
  )
  const workingState = await ipc.invoke('db:chapter-working-state-get', params.scene.chapterNumber)
  const cast = await sceneCharacters(params.scene.chapterNumber, workingState)
  const messages = buildDistillMessages({
    config: await fetchConfig(),
    characterNames: cast.map((c) => c.name),
    chapterTitle: params.chapterTitle,
    chapterGoal: params.chapterGoal,
    sceneTitle: params.scene.title,
    sceneGoal: params.scene.goal,
    turns: turns.map((t) => ({ role: t.role, content: t.content })),
    references,
  })
  const res = await useLLMStore.getState().generate(messages)
  if (!res.success) throw new Error(res.error || '蒸馏失败')
  const { prose } = splitProseAndState(res.content)
  if (!prose.trim()) throw new Error('蒸馏没有写出正文')
  return prose.trim()
}

/** 收场落盘 */
export async function commitScene(sceneId: number, body: string): Promise<void> {
  const res = await ipc.invoke('db:scene-commit', sceneId, body)
  if (!res.success) throw new Error(res.error || '收场失败')
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
