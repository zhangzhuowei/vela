import type { WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../ipc-client'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'
import { stripThinkingTags } from './workflow-utils'
import { parseJSONLenient, parseJSONWithRepair } from './json-repair'
import i18n from '../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================

export type ChapterBlueprint = BlueprintData

const BLUEPRINT_ROLES = ['建置', '铺垫', '发展', '冲突', '高潮', '转折', '收尾'] as const

const BLUEPRINT_ROLE_ALIASES: Record<string, (typeof BLUEPRINT_ROLES)[number]> = {
  建置: '建置',
  起: '建置',
  setup: '建置',
  opening: '建置',
  铺垫: '铺垫',
  foreshadow: '铺垫',
  groundwork: '铺垫',
  发展: '发展',
  承: '发展',
  development: '发展',
  развитие: '发展',
  冲突: '冲突',
  conflict: '冲突',
  高潮: '高潮',
  climax: '高潮',
  转折: '转折',
  转: '转折',
  turning: '转折',
  'turning point': '转折',
  twist: '转折',
  收尾: '收尾',
  合: '收尾',
  resolution: '收尾',
  ending: '收尾',
}

/** 把模型返回的章节定位收到编辑器那七个值；认不出则空串，交给默认值 */
export function normalizeBlueprintRole(raw: string): string {
  const key = raw.trim().toLowerCase()
  if (!key) return ''
  for (const role of BLUEPRINT_ROLES) {
    if (role === raw.trim() || role.toLowerCase() === key) return role
  }
  return BLUEPRINT_ROLE_ALIASES[key] ?? ''
}

const EMPTY_BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 0,
  title: '',
  role: '',
  purpose: '',
  keyEvents: '',
  characters: [],
  suspenseHook: '',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

export interface DirectoryWorkflowParams {
  mode: 'full' | 'append'
  startChapter?: number
  count?: number
  /** 节奏/风格指导（可选） */
  pacingGuidance?: string
}

// ==========================================
// 2. 蓝图文件访问与工具函数
// ==========================================

export type DirectoryPromptPlan = {
  templateKey: 'chapter_blueprint' | 'chapter_blueprint_chunk'
  numberOfChapters: number
  from: number
  to: number
}

/** 全量首包只要本批，不要一次要到全书 endChapter */
export function planDirectoryPrompt(params: {
  mode: 'full' | 'append'
  cursor: number
  batchEnd: number
  endChapter: number
  totalChapters: number
}): DirectoryPromptPlan {
  if (params.mode === 'full' && params.cursor === 1) {
    return {
      templateKey: 'chapter_blueprint',
      numberOfChapters: params.batchEnd,
      from: params.cursor,
      to: params.batchEnd,
    }
  }
  return {
    templateKey: 'chapter_blueprint_chunk',
    numberOfChapters: params.totalChapters,
    from: params.cursor,
    to: params.batchEnd,
  }
}

function unwrapBlueprintList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const blueprints = (parsed as { blueprints?: unknown }).blueprints
    if (Array.isArray(blueprints)) return blueprints
  }
  return null
}

function extractBlueprintList(jsonStr: string): unknown[] {
  const firstObj = jsonStr.indexOf('{')
  const firstArr = jsonStr.indexOf('[')
  if (firstObj === -1 && firstArr === -1) return []

  const arrayFirst = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)
  if (arrayFirst) {
    const { data } = parseJSONLenient(jsonStr.slice(firstArr))
    return unwrapBlueprintList(data) ?? []
  }

  const endIndex = jsonStr.lastIndexOf('}')
  if (endIndex > firstObj) {
    try {
      const parsed = parseJSONWithRepair(jsonStr.slice(firstObj, endIndex + 1))
      const list = unwrapBlueprintList(parsed)
      if (list) return list
    } catch {
      /* 包装对象被截断时，抢救内部已完整的数组元素 */
    }
  }

  if (firstArr !== -1) {
    const { data } = parseJSONLenient(jsonStr.slice(firstArr))
    return unwrapBlueprintList(data) ?? []
  }
  return []
}

export function parseTextBlueprints(content: string, startNum: number, endNum: number): ChapterBlueprint[] {
  let result: ChapterBlueprint[] = []

  try {
    const cleanContent = stripThinkingTags(content)
    const jsonStr = cleanContent.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = extractBlueprintList(jsonStr)
    result = parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .filter((p) => {
        const n = Number(p.chapterNumber || p.chapter_number)
        return n >= startNum && n <= endNum
      })
      .map((p) => ({
        ...EMPTY_BLUEPRINT,
        chapterNumber: Number(p.chapterNumber || p.chapter_number || 0),
        title: String(p.title || t('workflowDefs.chapterTitleFallback', { chapter: p.chapterNumber })),
        role: normalizeBlueprintRole(String(p.role || '')) || t('workflowDefs.dirDefaultRole'),
        purpose: String(p.purpose || ''),
        keyEvents: String(p.keyEvents || p.key_events || ''),
        characters: Array.isArray(p.characters) ? p.characters : [],
        suspenseHook: String(p.suspenseHook || p.suspense_hook || ''),
        userGuidance: '',
      }))
  } catch {
    console.error('Failed to parse blueprint JSON', content)
  }

  const distinctMap = new Map<number, ChapterBlueprint>()
  for (const item of result) {
    if (!distinctMap.has(item.chapterNumber)) distinctMap.set(item.chapterNumber, item)
  }

  return Array.from(distinctMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export async function loadDirectoryBlueprints(): Promise<ChapterBlueprint[]> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.sort((a, b) => a.chapterNumber - b.chapterNumber)
  } catch {
    return []
  }
}

export async function saveChapterBlueprint(blueprint: ChapterBlueprint): Promise<void> {
  await ipc.invoke('db:blueprint-upsert', blueprint)
}

export async function saveAllBlueprints(blueprints: ChapterBlueprint[]): Promise<void> {
  await ipc.invoke('db:blueprint-upsert-many', blueprints)
}

/** 库里有、当前列表没有的章号（删除后保存时要真正删行） */
export function chapterNumbersMissing(existing: number[], keep: number[]): number[] {
  const keepSet = new Set(keep)
  return existing.filter((n) => !keepSet.has(n))
}

export async function deleteChapterBlueprint(chapterNumber: number): Promise<{ success: boolean; error?: string }> {
  return ipc.invoke('db:blueprint-delete', chapterNumber)
}

export async function getBlueprintCount(): Promise<number> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.length
  } catch {
    return 0
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// ==========================================

export function createDirectoryWorkflow(params: DirectoryWorkflowParams = { mode: 'full' }): WorkflowDefinition {
  return {
    type: 'directory',
    title: params.mode === 'append' ? t('workflowDefs.dirAppendTitle', { chapter: params.startChapter || '' }) : t('workflowDefs.dirFullTitle'),
    steps: [
      {
        name: t('workflowDefs.dirStepReadArch'),
        description: t('workflowDefs.dirStepReadArchDesc'),
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error(t('common.noProject'))

          callbacks.log(t('workflowDefs.dirReadingArch'))
          const core = await ipc.invoke('db:project-core-get')
          if (!core) throw new Error(t('workflowDefs.dirCoreDataNotInit'))

          const parts: string[] = []
          if (core.premise && core.premise.length > 50) parts.push(core.premise)
          if (core.charactersArch && core.charactersArch.length > 50) parts.push(core.charactersArch)
          if (core.worldbuilding && core.worldbuilding.length > 50) parts.push(core.worldbuilding)
          if (core.synopsis && core.synopsis.length > 50) parts.push(core.synopsis)

          if (parts.length === 0) throw new Error(t('workflowDefs.dirArchNotGenerated'))

          context.data.architecture = parts.join('\n\n---\n\n')
          // 注入节奏指导到 context，供 Command 读取
          if (params.pacingGuidance) context.data.pacingGuidance = params.pacingGuidance
          if (params.mode === 'append') {
            const existing = await loadDirectoryBlueprints()
            context.data.existingBlueprints = existing
            callbacks.log(t('workflowDefs.dirLoadedBlueprints', { count: existing.length }))
          }
          return t('workflowDefs.dirArchLoaded', { count: parts.length })
        },
      },
      {
        name: t('workflowDefs.dirStepGenerate'),
        description: t('workflowDefs.dirStepGenerateDesc'),
        executor: async (_step, context, callbacks) => {
          const { GenerateDirectoryCommand } = await import('./commands/directory.command')
          const cmd = new GenerateDirectoryCommand(params)
          const blueprints = await cmd.execute({ step: _step, context, callbacks })
          // 返回可读摘要字符串（step.result 必须是 string，否则 AIOutputPanel 渲染会崩溃）
          return t('workflowDefs.dirGeneratedBlueprints', { count: blueprints.length })
        },
      },
      {
        name: t('workflowDefs.dirStepSave'),
        description: t('workflowDefs.dirStepSaveDesc'),
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error(t('common.noProject'))

          const newBlueprints = context.data.newBlueprints as ChapterBlueprint[]
          const existingBlueprints = context.data.existingBlueprints as ChapterBlueprint[]

          callbacks.log(t('workflowDefs.dirSavingBlueprints'))

          let merged: ChapterBlueprint[]
          if (params.mode === 'full') {
            merged = newBlueprints
            // TODO: 若需要清理冗余蓝图，可考虑添加 db:blueprint-delete-all 以严格符合全量替换的意图。
            // 在当前 upsert-many 中，仅覆盖更新
          } else {
            const existingMap = new Map(existingBlueprints.map(b => [b.chapterNumber, b]))
            for (const nb of newBlueprints) existingMap.set(nb.chapterNumber, nb)
            merged = Array.from(existingMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
          }

          await saveAllBlueprints(merged)
          useProjectStore.getState().refreshFileTree()
          return t('workflowDefs.dirBlueprintsSaved')
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: params.mode === 'append' ? t('workflowDefs.dirCompletedAppend') : t('workflowDefs.dirCompletedFull'),
    },
  }
}
