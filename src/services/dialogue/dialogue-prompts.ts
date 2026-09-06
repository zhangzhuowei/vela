/**
 * 对话创作模式 — 提示词组装
 *
 * 系统提示词走 prompt-templates 三级覆盖体系（项目 > 全局 > 内置），
 * 可在「设置 → 提示词模板」自定义。<state> / <options> 格式合同与 Mod
 * 贴底一起钉在整段对话之后，不进顶部 system。
 */
import { pinPostHistory } from '../llm-request-inspect'
import { getPromptTemplate, renderPrompt } from '../prompt-templates'
import { splitProseAndState } from './state-protocol'
import { wordlistUsageNote } from '../kb-allocate'
import type { WorkingState } from '../../shared/ipc-channels'

export { pinPostHistory }

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
  const lines = refs.map((r, i) => `[${i + 1}]（${r.fileName}）${r.text}`)
  const note = wordlistUsageNote(refs)
  if (note) lines.push(note)
  return lines.join('\n')
}

function styleGuidance(config: DialogueConfig): string {
  return [config.globalGuidance, config.writingStyle].filter(Boolean).join('；') || '（未设定）'
}

function sceneLine(title: string, goal: string): string {
  return title + (goal ? ` — ${goal}` : '')
}

/** 拼接贴底各段（Mod 指导 + 格式合同），空段丢弃。 */
export function composeDialoguePostHistory(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join('\n\n')
}

/** 格式合同特征句：请求监控用它识别「仅钉格式、没有 Mod」的贴底。 */
export const DIALOGUE_FORMAT_PIN_MARKER =
  '正文写完后，另起一行输出本轮角色状态变化（只含有变化的字段，角色名为键）：'

/** 场内生成的格式合同：状态块 + 可选控场选项。钉在对话之后，抗漏。 */
export function dialogueFormatContract(optionCount?: number, optionMaxChars?: number): string {
  const state =
    `${DIALOGUE_FORMAT_PIN_MARKER}\n` +
    '字段仅限 location、physicalState、mentalState、keyItems、recentEvents、knownInfo。\n' +
    '只输出真实标签，例如 <state>{"角色名":{"location":"现场"}}</state>；没有变化则 <state>{}</state>。\n' +
    '不要把本段说明、空字段模板、「占位」「不写」写进正文，也不要把标签改成《state》。'
  const options = optionCount
    ? `正文与状态块写完后，再输出恰好 ${optionCount} 条下一轮控场方向${
        optionMaxChars === 0 ? '' : `，每条不超过 ${optionMaxChars ?? 24} 字`
      }，互不重复，覆盖不同走向。只写方向，不要解释。格式：\n<options>\n${Array.from({ length: optionCount }, (_, i) => `${i + 1}. …`).join('\n')}\n</options>`
    : ''
  return composeDialoguePostHistory(state, options)
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
  /** 场间前情（上一场结尾或本章已收场摘要，未启用则不传） */
  scenePrelude?: string
  /** 本轮结束后给出的控场选项条数（未设置则不要求输出选项） */
  optionCount?: number
  /** 每条选项的字数上限；0 = 不限；未传则默认 24 */
  optionMaxChars?: number
  /** 启用 Mod 的行文指导，贴在整段对话之后 */
  postHistory?: string
  /** 场内生成默认钉格式合同；续写/服务层自己拼贴底时关掉，避免夹进 core */
  skipFormat?: boolean
  /** 设定纲要常驻摘要（未配置时不传） */
  settingDigest?: string
}): ChatMessage[] {
  const { config, characters, workingState } = params
  const template = getPromptTemplate('dialogue_scene')
  if (!template) throw new Error('内置模板 dialogue_scene 丢失')

  const system = renderPrompt(template, {
    world_setting: config.worldSetting?.trim() || '（未设定）',
    setting_digest: params.settingDigest?.trim() || '',
    protagonist_profile: config.protagonistProfile?.trim() || '（未设定）',
    style_guidance: styleGuidance(config),
    chapter_title: params.chapterTitle,
    chapter_goal: params.chapterGoal || '（未写）',
    scene_line: sceneLine(params.sceneTitle, params.sceneGoal),
    line_context: [
      params.scenePrelude?.trim(),
      params.lineContext?.trim() ? `本线前情：${params.lineContext.trim()}` : '',
    ].filter(Boolean).join('\n'),
    length_note: params.targetLength
      ? `本轮篇幅：目标约 ${params.targetLength} 字，硬性下限 ${Math.round(params.targetLength * 0.8)} 字，这是必须满足的要求。用足场景推进、动作细节与对白把篇幅写满，不要注水，也绝不允许提前收束。`
      : '',
    option_note: '',
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
  return pinPostHistory(
    messages,
    params.skipFormat
      ? params.postHistory
      : composeDialoguePostHistory(params.postHistory, dialogueFormatContract(params.optionCount, params.optionMaxChars))
  )
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
  /** 启用 Mod 的行文指导，贴在逐字稿之后 */
  postHistory?: string
  /** 设定纲要常驻摘要（未配置时不传） */
  settingDigest?: string
}): ChatMessage[] {
  const { config } = params
  const template = getPromptTemplate('dialogue_distill')
  if (!template) throw new Error('内置模板 dialogue_distill 丢失')

  const system = renderPrompt(template, {
    world_setting: config.worldSetting?.trim() || '（未设定）',
    setting_digest: params.settingDigest?.trim() || '',
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
    .map((t) => `${t.role === 'user' ? '控场' : '草稿'}：${splitProseAndState(t.content).prose}`)
    .join('\n\n')

  return pinPostHistory(
    [
      { role: 'system', content: system },
      { role: 'user', content: transcript },
    ],
    params.postHistory
  )
}
