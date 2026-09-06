/**
 * 设定纲要：整册级工具
 *   - SplitWorldbuildingCommand：把故事架构的世界观拆进空模块（不覆盖已有内容）
 *   - CrossCheckSettingsCommand：找模块之间的矛盾 / 重复 / 留白，只报告不改
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import { getPromptTemplate, renderPrompt, getLocalizedSystemRole } from '../../prompt-templates'
import i18n from '../../../i18n'
import {
  GRID_KEYS,
  defaultModulesForGenre,
  emptyGrid,
  isGridEmpty,
  serializeGrid,
  type SettingGrid,
  type SettingModuleData,
} from '../../setting-bible'
import { listSettingModules, saveSettingModule } from '../../setting-bible-service'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

export interface SplitResult {
  filled: number
  created: number
}

interface SplitItem {
  key?: string
  title?: string
  规则?: string
  例外?: string
  进戏?: string
  禁止?: string
}

export class SplitWorldbuildingCommand extends BaseWorkflowCommand<SplitResult> {
  protected attachModGuidance = true

  async execute({ callbacks }: CommandExecuteParams): Promise<SplitResult> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))
    const core = await ipc.invoke('db:project-core-get')
    const worldbuilding = (core?.worldbuilding || '').trim()
    if (worldbuilding.length < 100) throw new Error(t('settingModule.splitNoWorldbuilding'))

    const template = getPromptTemplate('setting_split_worldbuilding')
    if (!template) throw new Error(t('common.templateMissing'))

    const modules = await listSettingModules()
    const specs = defaultModulesForGenre(project.novelConfig.genre)
    const moduleList = modules
      .map((m) => {
        const hint = specs.find((s) => s.key === m.key)?.hint || ''
        return `- key=${m.key} | ${m.title}${hint ? ` | ${hint}` : ''} | ${isGridEmpty(m.body) ? '空' : '已有内容'}`
      })
      .join('\n') || t('settingModule.noOtherModules')

    callbacks.log(t('settingModule.splitting'))
    const prompt = renderPrompt(template, {
      genre: project.novelConfig.genre || t('architecture.unfilled'),
      core_setting: (project.novelConfig.worldSetting || '').slice(0, 800) || t('architecture.unfilled'),
      worldbuilding: worldbuilding.slice(0, 8000),
      module_list: moduleList,
    })
    const raw = await this.callLLM(prompt, getLocalizedSystemRole(template), callbacks, { responseFormat: { type: 'json_object' } })

    let items: SplitItem[]
    try {
      const parsed = this.parseJSON<{ modules?: SplitItem[] } | SplitItem[]>(this.stripThinkingTags(raw))
      items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.modules) ? parsed.modules : []
    } catch {
      throw new Error(t('settingModule.splitParseFailed'))
    }

    let filled = 0
    let created = 0
    let nextOrder = modules.length
    for (const item of items) {
      const grid = toGrid(item)
      if (GRID_KEYS.every((k) => !grid[k])) continue
      const existing = item.key ? modules.find((m) => m.key === item.key) : undefined
      if (existing) {
        if (!isGridEmpty(existing.body)) continue
        await saveSettingModule({ ...existing, body: serializeGrid(grid), source: 'ai' })
        filled++
        continue
      }
      const title = (item.title || '').trim()
      if (!title || created >= 3) continue
      const key = sanitizeKey(item.key) || `new_${Date.now().toString(36)}_${created}`
      await saveSettingModule({
        key,
        title,
        sortOrder: nextOrder++,
        injectMode: 'retrieval',
        body: serializeGrid(grid),
        summary: '',
        source: 'ai',
        kbDocId: '',
      })
      created++
    }
    callbacks.log(t('settingModule.splitDone', { filled, created }))
    return { filled, created }
  }
}

function toGrid(item: SplitItem): SettingGrid {
  const g = emptyGrid()
  for (const k of GRID_KEYS) {
    const v = item[k]
    g[k] = typeof v === 'string' ? v.trim() : ''
  }
  return g
}

function sanitizeKey(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const k = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return k.startsWith('new_') ? k.slice(0, 60) : ''
}

export class CrossCheckSettingsCommand extends BaseWorkflowCommand<string> {
  protected attachModGuidance = true

  async execute({ callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))
    const template = getPromptTemplate('setting_cross_check')
    if (!template) throw new Error(t('common.templateMissing'))

    const modules = (await listSettingModules()).filter((m) => m.injectMode !== 'off' && !isGridEmpty(m.body))
    if (modules.length < 2) throw new Error(t('settingModule.crossCheckTooFew'))

    callbacks.log(t('settingModule.crossChecking', { count: modules.length }))
    const prompt = renderPrompt(template, {
      genre: project.novelConfig.genre || t('architecture.unfilled'),
      modules_text: modules.map(renderForCheck).join('\n\n'),
    })
    const raw = await this.callLLM(prompt, getLocalizedSystemRole(template), callbacks)
    return this.stripThinkingTags(raw).trim()
  }
}

function renderForCheck(m: SettingModuleData): string {
  return `### ${m.title}（key=${m.key}）\n${m.body.trim()}`
}
