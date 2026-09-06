import type { WorkflowDefinition, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import { getPromptTemplate } from '../prompt-templates'
import { ipc } from '../ipc-client'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { CharacterData } from '../../../electron/repositories/character-repository'
import i18n from '../../i18n'

import { runPostProcessPipeline, type PostProcessStep, stripThinkingTags, mergePreservedCharacterAssets } from './workflow-utils'
import { parseJSONLenient } from './json-repair'

/** 单批送入 LLM 的角色图谱文本长度上限（字符）。超出后模型的 JSON 输出极易撞上 max_tokens 而被截断。 */
const EXTRACT_BATCH_MAX_CHARS = 1800
/** 单批最多包含的角色条目数。 */
const EXTRACT_BATCH_MAX_ENTRIES = 3

/**
 * 将角色图谱文本切分为独立的角色条目。
 * 依次尝试若干常见的条目起始标记，全部失败时回退为按空行分段。
 */
function splitCharacterEntries(content: string): string[] {
  const patterns = [
    /(?=^[ \t]*姓名[：:])/m,      // 姓名：林澈
    /(?=^#{1,4}[ \t]+\S)/m,       // ### 林澈
    /(?=^[ \t]*\*\*[^*\n]+\*\*)/m, // **林澈**
  ]

  for (const pattern of patterns) {
    const parts = content.split(pattern).map((s) => s.trim()).filter((s) => s.length > 0)
    if (parts.length > 1) return parts
  }

  // 回退：按空行分段
  return content.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * 把角色条目打包成多个批次，使每批的文本量与条目数都在安全范围内。
 * 单个条目本身超长时独占一批（不再切分，避免把同一角色劈成两半）。
 */
function packEntriesIntoBatches(entries: string[]): string[] {
  const batches: string[] = []
  let current: string[] = []
  let currentChars = 0

  const flush = () => {
    if (current.length > 0) {
      batches.push(current.join('\n\n'))
      current = []
      currentChars = 0
    }
  }

  for (const entry of entries) {
    const willExceed = currentChars + entry.length > EXTRACT_BATCH_MAX_CHARS
    const isFull = current.length >= EXTRACT_BATCH_MAX_ENTRIES
    if (current.length > 0 && (willExceed || isFull)) flush()

    current.push(entry)
    currentChars += entry.length

    if (entry.length >= EXTRACT_BATCH_MAX_CHARS) flush()
  }
  flush()

  return batches
}

/** 从一段角色图谱文本中提取角色卡数组（单次 LLM 调用）。 */
async function extractCardsFromChunk(
  chunk: string,
  genre: string,
  cb: { log: (msg: string) => void; appendText: (text: string) => void },
): Promise<{ cards: Array<Record<string, unknown>>; truncated: boolean }> {
  const { ArchitecturePromptBuilder } = await import('../prompts/prompt-builder')
  const template = getPromptTemplate('extract_initial_characters')
  if (!template) throw new Error('未找到 extract_initial_characters')

  const extractPrompt = new ArchitecturePromptBuilder(template).withCharacterDynamics(chunk).withGenre(genre).build()
  const systemRole = template.systemRole || '你是一位专业的小说数据结构化专家。'

  const llmStore = useLLMStore.getState()
  let fullContent = ''
  await new Promise<void>((resolve, reject) => {
    llmStore.generateStream(
      [
        { role: 'system', content: systemRole },
        { role: 'user', content: extractPrompt },
      ],
      {
        onChunk: (c) => { fullContent += c; cb.appendText(c) },
        onDone: () => resolve(),
        onError: (err) => reject(new Error(err)),
      },
      undefined,
      { responseFormat: { type: 'json_object' } },
    )
  })

  const cleaned = stripThinkingTags(fullContent)
  const jsonStr = cleaned.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
  const { data: parsedData, truncated } = parseJSONLenient(jsonStr)

  // 兼容多种格式：直接数组、{ characters: [...] }、或其他包含数组的对象
  let cards: Array<Record<string, unknown>> = []
  if (Array.isArray(parsedData)) {
    cards = parsedData as Array<Record<string, unknown>>
  } else if (parsedData && typeof parsedData === 'object') {
    const obj = parsedData as Record<string, unknown>
    if (Array.isArray(obj.characters)) {
      cards = obj.characters as Array<Record<string, unknown>>
    } else {
      for (const value of Object.values(obj)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
          cards = value as Array<Record<string, unknown>>
          break
        }
      }
    }
  }

  if (cards.length === 0) {
    throw new Error(`AI 返回的角色数据格式不正确，未提取到有效角色。原始内容预览: ${cleaned.slice(0, 300)}`)
  }

  return { cards, truncated }
}

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

// ==========================================
// 1. 类型定义
// ==========================================

export interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
}

/** 架构生成的步骤键；setting_bible 是第五步：铺默认清单并批量生成空模块 */
export type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis' | 'setting_bible'

export interface ArchitectureWorkflowParams {
  selectedSteps?: ArchStepKey[]
  /** 每步的补充指导（如 { premise: "多强调金手指的限制" }） */
  stepGuidance?: Record<string, string>
}

export interface ConfigGenerationWorkflowParams {
  idea: string
  totalChapters: number
  wordsPerChapter: number
  onGenerated: (config: Partial<NovelConfig>) => void
}

// ==========================================
// 2. 工作流定义
// ==========================================

export function createArchitectureWorkflow(params: ArchitectureWorkflowParams = {}): WorkflowDefinition {
  const sel = params.selectedSteps ?? ['premise', 'characters', 'worldbuilding', 'synopsis']
  const stepDesc = (key: string, defaultKey: string) => sel.includes(key as never) ? t(defaultKey) : t('workflowDefs.stepSkipDesc')
  // 闭包捕获逐步指导，executor 中注入到 context.data
  const guidance = params.stepGuidance || {}

  const allSteps = [
    {
      name: t('workflowDefs.stepPremise'),
      key: 'premise',
      description: stepDesc('premise', 'workflowDefs.stepPremiseDesc'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateCoreSeedCommand } = await import('./commands/architecture.command')
        return new GenerateCoreSeedCommand().execute({ step, context, callbacks })
      },
    },
    {
      name: t('workflowDefs.stepCharacters'),
      key: 'characters',
      description: stepDesc('characters', 'workflowDefs.stepCharactersDesc'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateCharactersCommand } = await import('./commands/architecture.command')
        return new GenerateCharactersCommand().execute({ step, context, callbacks })
      },
    },
    {
      name: t('workflowDefs.stepWorldbuilding'),
      key: 'worldbuilding',
      description: stepDesc('worldbuilding', 'workflowDefs.stepWorldbuildingDesc'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateWorldBuildingCommand } = await import('./commands/architecture.command')
        return new GenerateWorldBuildingCommand().execute({ step, context, callbacks })
      },
    },
    {
      name: t('workflowDefs.stepSynopsis'),
      key: 'synopsis',
      description: stepDesc('synopsis', 'workflowDefs.stepSynopsisDesc'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GeneratePlotArchitectureCommand } = await import('./commands/architecture.command')
        return new GeneratePlotArchitectureCommand(sel).execute({ step, context, callbacks })
      },
    },
    {
      name: t('workflowDefs.stepSettingBible'),
      key: 'setting_bible',
      description: stepDesc('setting_bible', 'workflowDefs.stepSettingBibleDesc'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { BatchGenerateSettingModulesCommand } = await import('./commands/setting-bible-tools.command')
        const result = await new BatchGenerateSettingModulesCommand().execute({ step, context, callbacks })
        return t('settingModule.batchDone', { done: result.done, failed: result.failed.length })
      },
    },
  ]

  const finalSteps = allSteps.filter(s => sel.includes(s.key as never))

  return {
    type: 'architecture_generation',
    title: t('workflowDefs.architectureTitle'),
    steps: finalSteps,
    onComplete: { mode: 'silent', message: t('workflowDefs.architectureCompletedMessage') },
  }
}

export function createConfigGenerationWorkflow(params: ConfigGenerationWorkflowParams): WorkflowDefinition {
  return {
    type: 'config_generation',
    title: t('workflowDefs.configGenTitle'),
    steps: [
      {
        name: t('workflowDefs.configGenStepName'),
        description: t('workflowDefs.configGenStepDesc', { chapters: params.totalChapters }),
        executor: async (step, context, callbacks) => {
          const { GenerateConfigCommand } = await import('./commands/architecture.command')
          const cmd = new GenerateConfigCommand(params.idea, params.totalChapters, params.wordsPerChapter, params.onGenerated)
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'silent', message: t('workflowDefs.configGenCompleted') },
  }
}

// ==========================================
// 3. 工具与指导文本
// ==========================================

export function getPlotStructureGuide(structure: string, totalChapters: number): string {
  const ch20 = Math.round(totalChapters * 0.2)
  const ch25 = Math.round(totalChapters * 0.25)
  const ch50 = Math.round(totalChapters * 0.5)
  const ch75 = Math.round(totalChapters * 0.75)

  switch (structure) {
    case 'heros_journey':
      return t('workflowDefs.guideHerosJourney', { total: totalChapters })
    case 'save_the_cat':
      return t('workflowDefs.guideSaveTheCat', { total: totalChapters })
    case 'kishotenketsu':
      return t('workflowDefs.guideKishotenketsu', {
        total: totalChapters, ch25, ch25Next: ch25 + 1,
        ch50, ch50Next: ch50 + 1, ch75, ch75Next: ch75 + 1,
      })
    case 'multi_thread':
      return t('workflowDefs.guideMultiThread', { total: totalChapters, ch25, ch50, ch75 })
    case 'freeform':
      return t('workflowDefs.guideFreeform', { total: totalChapters })
    case 'three_act':
    default:
      return t('workflowDefs.guideThreeAct', {
        total: totalChapters, ch20, ch20Next: ch20 + 1,
        ch75, ch75Next: ch75 + 1,
      })
  }
}

export function getNarrativePOVLabel(pov: string): string {
  const labels: Record<string, string> = {
    first_person: t('workflowDefs.povFirstPerson'),
    third_limited: t('workflowDefs.povThirdLimited'),
    third_omniscient: t('workflowDefs.povThirdOmniscient'),
    multi_pov: t('workflowDefs.povMultiPov'),
  }
  return labels[pov] || pov
}

// ==========================================
// 4. 角色卡后处理逻辑
// ==========================================

export const ARCH_CHARACTER_SCOPE = 'arch_characters'

export function createCharacterExtractSteps(_projectPath: string, characterDynamicsContent: string, genre: string): PostProcessStep[] {
  return [
    {
      key: 'extract_character_cards',
      label: t('workflowDefs.charExtractLabel'),
      critical: true,
      executor: async (cb) => {
        // 角色图谱可能包含数十个角色，一次性要求 LLM 输出全部 JSON 必然撞上单次输出上限
        // （被截断后即使抢救也会漏角色），因此在此按角色条目自动分批，逐批提取后合并入库。
        const entries = splitCharacterEntries(characterDynamicsContent)
        const batches = packEntriesIntoBatches(entries)

        cb.log(`📖 角色图谱共识别出 ${entries.length} 个角色条目，将分 ${batches.length} 批提取`)

        // 按角色名合并，避免同名角色重复入库（后出现的覆盖先前的）
        const cardMap = new Map<string, Record<string, unknown>>()
        const failedBatches: number[] = []
        let truncatedCount = 0

        for (let i = 0; i < batches.length; i++) {
          const label = `第 ${i + 1}/${batches.length} 批`
          cb.appendText(`\n🔍 ${label} 正在提取...\n`)
          try {
            const { cards, truncated } = await extractCardsFromChunk(batches[i], genre, cb)
            if (truncated) truncatedCount++
            for (const card of cards) {
              const name = typeof card.name === 'string' ? card.name.trim() : ''
              if (!name) continue
              cardMap.set(name, card)
            }
            cb.log(`✅ ${label} 完成，累计 ${cardMap.size} 个角色`)
          } catch (e) {
            // 单批失败不中断整体，记录后继续，避免一批出错导致全部白跑
            failedBatches.push(i + 1)
            cb.log(`⚠️ ${label} 提取失败：${String(e)}`)
          }
        }

        if (truncatedCount > 0) {
          cb.log(`⚠️ 有 ${truncatedCount} 批的输出被截断，已抢救其中完整的角色对象，这些批次可能仍有遗漏。`)
        }
        if (failedBatches.length > 0) {
          cb.log(`⚠️ 以下批次提取失败：${failedBatches.join('、')}。可稍后重新点击提取，已入库的角色不会丢失。`)
        }

        if (cardMap.size === 0) {
          throw new Error('所有批次均未提取到有效角色，请检查角色图谱内容与模型配置')
        }

        // 构建角色卡数据列表
        const validRoles = ['protagonist', 'antagonist', 'supporting', 'minor']
        const characterDataList: Array<Record<string, unknown>> = []
        for (const card of cardMap.values()) {
          const role = validRoles.includes(card.role as string) ? card.role : 'supporting'
          characterDataList.push({ ...card, role, name: card.name })
        }

        // 并回库中已有的口癖/人设图，避免重新提取覆盖已生成/已推断的数据，再批量写入
        const merged = await mergePreservedCharacterAssets(characterDataList as unknown as CharacterData[])
        await ipc.invoke('db:character-save-all', merged)

        const missing = entries.length - merged.length
        cb.log(`✅ 角色卡提取完毕（共 ${merged.length} 个角色${missing > 0 ? `，识别到的条目中有 ${missing} 个未成功提取` : ''}）`)
      },
    },
  ]
}

export function runArchCharacterExtract(projectPath: string, characterDynamicsContent: string, genre: string): void {
  const steps = createCharacterExtractSteps(projectPath, characterDynamicsContent, genre)
  import('../../stores/workflow-store').then(async ({ useWorkflowStore }) => {
    await useWorkflowStore.getState().startWorkflow({
      type: 'post_process',
      title: t('workflowDefs.charExtractTitle'),
      steps: [
        {
          name: t('workflowDefs.charExtractStepName'),
          description: t('workflowDefs.charExtractStepDesc'),
          executor: async (_step, _ctx, callbacks) => {
            const { globalEventBus } = await import('../../shared/event-bus')
            const archStatus = await runPostProcessPipeline(projectPath, ARCH_CHARACTER_SCOPE, t('workflowDefs.sourceLabelArchCharacters'), steps, callbacks)
            if (archStatus.allCriticalPassed) {
              // 角色卡提取成功 → 通过 EventBus 通知 ProjectService 刷新
              globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {})
            } else {
              const extractError = archStatus.steps.extract_character_cards?.error
              globalEventBus.emit('CHARACTER_EXTRACT_FAILED', { error: extractError })
              globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {})
              // 抛出以便工作流面板显示为失败，避免提取失败却显示成功、角色卡实际为空
              throw new Error(`角色卡提取失败：${extractError || '未知原因'}`)
            }
          },
        },
      ],
    })
  })
}

export async function repairArchCharacterCards(projectPath: string): Promise<void> {
  const core = await ipc.invoke('db:project-core-get')
  if (!core?.charactersArch || core.charactersArch.length < 50) throw new Error(t('workflowDefs.charExtractFailed'))

  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error(t('common.noProject'))

  const steps = createCharacterExtractSteps(projectPath, core.charactersArch, project.novelConfig.genre)
  const { useWorkflowStore } = await import('../../stores/workflow-store')
  await useWorkflowStore.getState().startWorkflow({
    type: 'post_process',
    title: t('workflowDefs.charRepairTitle'),
    steps: [
      {
        name: t('workflowDefs.charRepairStepName'),
        description: t('workflowDefs.charRepairStepDesc'),
        executor: async (_step, _ctx, callbacks) => {
          const { globalEventBus } = await import('../../shared/event-bus')
          const archStatus = await runPostProcessPipeline(projectPath, ARCH_CHARACTER_SCOPE, '架构-角色图谱', steps, callbacks, { onlyFailed: true })
          globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {})
          if (!archStatus.allCriticalPassed) {
            const extractError = archStatus.steps.extract_character_cards?.error
            throw new Error(`角色卡提取失败：${extractError || '未知原因'}`)
          }
        },
      },
    ],
  })
}

