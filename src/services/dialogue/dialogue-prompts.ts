/**
 * 对话创作模式 — 提示词组装
 *
 * 系统提示词走 prompt-templates 三级覆盖体系（项目 > 全局 > 内置），
 * 可在「设置 → 提示词模板」自定义；<state> 状态协议与蒸馏输出约束
 * 放在 systemSuffix，渲染时强制取内置版本，自定义无法破坏解析。
 */
import { getPromptTemplate, renderPrompt } from '../prompt-templates'
import type { WorkingState } from '../../shared/ipc-channels'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type DialogueConfig = {
  worldSetting?: string
  protagonistProfile?: string
  globalGuidance?: string
  writingStyle?: string
}

export type DialogueCharacter = {
  name: string
  personality?: string
  appearance?: string
  speechStyle?: string
  relationships?: string
  background?: string
  motivation?: string
}

export type DialogueTurn = { role: 'user' | 'assistant'; content: string }

export type KnowledgeRef = { fileName: string; text: string }

function characterBlock(c: DialogueCharacter, state?: Record<string, string>): string {
  const bits: string[] = []
  if (c.personality) bits.push(`性格=${c.personality}`)
  if (c.appearance) bits.push(`外貌=${c.appearance}`)
  if (c.speechStyle) bits.push(`口吻=${c.speechStyle}`)
  if (c.relationships) bits.push(`关系=${c.relationships}`)
  if (c.motivation) bits.push(`动机=${c.motivation}`)
  const stateBits = Object.entries(state ?? {})
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}=${v}`)
  const card = bits.length ? ` 人设：${bits.join('；')}` : ''
  const st = stateBits.length ? ` 当前状态：${stateBits.join('；')}` : ''
  return `- ${c.name}${card}${st}`
}

function referencesBlock(refs?: KnowledgeRef[]): string {
  if (!refs || refs.length === 0) return '（无）'
  return refs.map((r, i) => `[${i + 1}]（${r.fileName}）${r.text}`).join('\n')
}

function styleGuidance(config: DialogueConfig): string {
  return [config.globalGuidance, config.writingStyle].filter(Boolean).join('；') || '（未设定）'
}

function sceneLine(title: string, goal: string): string {
  return title + (goal ? ` — ${goal}` : '')
}

export function buildSceneMessages(params: {
  config: DialogueConfig
  characters: DialogueCharacter[]
  workingState: WorkingState
  chapterTitle: string
  chapterGoal: string
  sceneTitle: string
  sceneGoal: string
  turns: DialogueTurn[]
  userInput?: string
  references?: KnowledgeRef[]
  /** 本轮目标字数（未设置则不注入篇幅要求） */
  targetLength?: number
  /** 同线上一场前情摘要（多线联动，未启用则不传） */
  lineContext?: string
}): ChatMessage[] {
  const { config, characters, workingState } = params
  const template = getPromptTemplate('dialogue_scene')
  if (!template) throw new Error('内置模板 dialogue_scene 丢失')

  const system = renderPrompt(template, {
    world_setting: config.worldSetting?.trim() || '（未设定）',
    protagonist_profile: config.protagonistProfile?.trim() || '（未设定）',
    style_guidance: styleGuidance(config),
    chapter_title: params.chapterTitle,
    chapter_goal: params.chapterGoal || '（未写）',
    scene_line: sceneLine(params.sceneTitle, params.sceneGoal),
    line_context: params.lineContext?.trim() ? `本线前情：${params.lineContext.trim()}` : '',
    length_note: params.targetLength
      ? `本轮篇幅：目标约 ${params.targetLength} 字，硬性下限 ${Math.round(params.targetLength * 0.8)} 字，这是必须满足的要求。用足场景推进、动作细节与对白把篇幅写满，不要注水，也绝不允许提前收束。`
      : '',
    characters_block:
      characters.map((c) => characterBlock(c, workingState[c.name])).join('\n') || '（暂无角色卡）',
    references_block: referencesBlock(params.references),
  })

  const messages: ChatMessage[] = [{ role: 'system', content: system }]
  for (const t of params.turns) {
    if (t.content) messages.push({ role: t.role, content: t.content })
  }
  if (params.userInput?.trim()) {
    messages.push({ role: 'user', content: params.userInput.trim() })
  }
  return messages
}

export function buildDistillMessages(params: {
  config: DialogueConfig
  characterNames: string[]
  chapterTitle: string
  chapterGoal: string
  sceneTitle: string
  sceneGoal: string
  turns: DialogueTurn[]
  references?: KnowledgeRef[]
  /** 蒸馏目标字数（未设置则忠实草稿体量） */
  targetLength?: number
}): ChatMessage[] {
  const { config } = params
  const template = getPromptTemplate('dialogue_distill')
  if (!template) throw new Error('内置模板 dialogue_distill 丢失')

  const system = renderPrompt(template, {
    world_setting: config.worldSetting?.trim() || '（未设定）',
    protagonist_profile: config.protagonistProfile?.trim() || '（未设定）',
    style_guidance: styleGuidance(config),
    chapter_title: params.chapterTitle,
    chapter_goal: params.chapterGoal || '（未写）',
    scene_line: sceneLine(params.sceneTitle, params.sceneGoal),
    length_note: params.targetLength
      ? `蒸馏篇幅：约 ${params.targetLength} 字上下，不得少于八成；宁可保留细节也不要为压缩丢失情节与关键对白。`
      : '',
    character_names: params.characterNames.join('、') || '（无）',
    references_block: referencesBlock(params.references),
  })

  const transcript = params.turns
    .map((t) => `${t.role === 'user' ? '控场' : '草稿'}：${t.content}`)
    .join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: transcript },
  ]
}
