/**
 * 设定纲要：单模块 AI 生成 / 按指令改写 / 常驻摘要
 *
 * 一次只动一个模块，其它模块只以摘要形式作为「不要矛盾」的参照，
 * 所以改「婚姻制度」不会顺手把「美貌等级」重写掉。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import { getPromptTemplate, renderPrompt, getLocalizedSystemRole } from '../../prompt-templates'
import i18n from '../../../i18n'
import {
  defaultModulesForGenre,
  effectiveSummary,
  GRID_KEYS,
  isGridEmpty,
  parseGrid,
  serializeGrid,
  SUMMARY_MAX,
  type SettingModuleData,
} from '../../setting-bible'
import { listSettingModules, saveSettingModule } from '../../setting-bible-service'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

export interface SettingModuleCommandOptions {
  /** generate：写四格（可带改写指令）；summary：只重做常驻摘要 */
  mode: 'generate' | 'summary'
  instruction?: string
}

export class GenerateSettingModuleCommand extends BaseWorkflowCommand<SettingModuleData | null> {
  /** 设定内容的尺度和题材边界跟正文一致，启用 Mod 的行文指导要挂上，否则模型会自我审查把制度写虚 */
  protected attachModGuidance = true

  constructor(private moduleId: number, private options: SettingModuleCommandOptions) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<SettingModuleData | null> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const modules = await listSettingModules()
    const target = modules.find((m) => m.id === this.moduleId)
    if (!target) throw new Error(t('settingModule.notFound'))

    if (this.options.mode === 'summary') {
      const summary = await this.summarize(target, callbacks)
      if (!summary) return target
      const saved = await saveSettingModule({ ...target, summary })
      callbacks.log(t('settingModule.summarySaved', { title: target.title }))
      return saved
    }

    const body = await this.generateBody(target, modules, callbacks)
    if (!body) return target
    // 常驻模块顺手把摘要一起刷掉，免得摘要还停留在上一版规则
    const summary = target.injectMode === 'always' ? await this.summarize({ ...target, body }, callbacks) : ''
    const saved = await saveSettingModule({ ...target, body, summary: summary || '', source: 'ai' })
    callbacks.log(t('settingModule.saved', { title: target.title }))
    return saved
  }

  private async generateBody(
    target: SettingModuleData,
    modules: SettingModuleData[],
    callbacks: CommandExecuteParams['callbacks'],
  ): Promise<string> {
    const project = useProjectStore.getState().currentProject!
    const config = project.novelConfig
    const core = await ipc.invoke('db:project-core-get')
    const template = getPromptTemplate('setting_module')
    if (!template) throw new Error(t('common.templateMissing'))

    const hint =
      defaultModulesForGenre(config.genre).find((s) => s.key === target.key)?.hint ||
      t('settingModule.genericHint', { title: target.title })
    const others = modules
      .filter((m) => m.id !== target.id && m.injectMode !== 'off')
      .map((m) => ({ title: m.title, text: effectiveSummary(m) }))
      .filter((x) => x.text)
      .map((x) => `- ${x.title}：${x.text}`)
      .join('\n')

    callbacks.log(
      this.options.instruction?.trim()
        ? t('settingModule.rewriting', { title: target.title })
        : t('settingModule.generating', { title: target.title }),
    )

    const prompt = renderPrompt(template, {
      genre: config.genre || t('architecture.unfilled'),
      sub_genre: config.subGenre || t('architecture.unfilled'),
      target_audience: config.targetAudience || t('architecture.unfilled'),
      premise: (core?.premise || config.coreOutline || t('architecture.unfilled')).slice(0, 1200),
      core_setting: (config.worldSetting || t('architecture.unfilled')).slice(0, 800),
      worldbuilding: (core?.worldbuilding || '').slice(0, 1500) || t('architecture.unfilled'),
      module_title: target.title,
      module_hint: hint,
      other_modules: others || t('settingModule.noOtherModules'),
      existing_body: isGridEmpty(target.body) ? '' : target.body,
      user_instruction: this.options.instruction?.trim() || '',
    })

    const raw = await this.callLLM(prompt, getLocalizedSystemRole(template), callbacks)
    const text = this.stripThinkingTags(raw).trim()
    if (!text) {
      callbacks.log(t('settingModule.emptyResult', { title: target.title }))
      return ''
    }
    return this.normalizeBody(text)
  }

  /** 模型没按四格输出时，把整段塞进「规则」，其余格保持原样，不让一次失败清空手改内容 */
  private normalizeBody(text: string): string {
    const grid = parseGrid(text)
    const filled = GRID_KEYS.filter((k) => grid[k].trim()).length
    if (filled >= 2) return serializeGrid(grid)
    return serializeGrid({ 规则: text.replace(/^##\s*\S+\s*$/gm, '').trim(), 例外: '', 进戏: '', 禁止: '' })
  }

  private async summarize(
    target: Pick<SettingModuleData, 'title' | 'body'>,
    callbacks: CommandExecuteParams['callbacks'],
  ): Promise<string> {
    if (isGridEmpty(target.body)) return ''
    const template = getPromptTemplate('setting_module_summary')
    if (!template) return ''
    callbacks.log(t('settingModule.summarizing', { title: target.title }))
    const prompt = renderPrompt(template, { module_title: target.title, body: target.body })
    try {
      const raw = await this.callLLM(prompt, getLocalizedSystemRole(template), callbacks)
      const s = this.stripThinkingTags(raw).replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim()
      return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s
    } catch {
      return ''
    }
  }
}
