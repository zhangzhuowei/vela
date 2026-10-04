import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import i18n from '../../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })


/**
 * 文风指纹分析命令
 *
 * 样本来源二选一：
 *  - 若构造时传入 sampleText（作者粘贴的样章），优先分析该文本；
 *  - 否则采样本项目最近 5 章已定稿正文。
 *
 * 提炼出的文风特征写入 NovelConfig.styleReference（「文风指纹」），
 * 与作者手写的 writingStyle（文风配置）并存、互不覆盖，写稿时一并注入。
 */
export class AnalyzeWritingStyleCommand extends BaseWorkflowCommand<string> {
  constructor(private sampleText?: string) {
    super()
  }

  async execute({ callbacks, context }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    let sampleText = ''

    if (this.sampleText?.trim()) {
      // 来源 A：作者粘贴的样章文本
      callbacks.log('📖 使用作者提供的样章文本分析文风...')
      sampleText = this.sampleText.trim().slice(0, 12000)
    } else {
      // 来源 B：采样本项目最近 5 章定稿正文
      callbacks.log(t('analyzeStyle.samplingChapters'))
      const sampleTexts: string[] = []
      try {
        const maxChap = await ipc.invoke('db:draft-get-max-finalized-chapter')
        if (maxChap <= 0) {
          callbacks.log('⚠️ 无已写章节，也未提供样章文本，无法分析文风')
          return ''
        }

        const startChap = Math.max(1, maxChap - 4)
        for (let c = maxChap; c >= startChap; c--) {
          const meta = await ipc.invoke('db:draft-get-finalized', c)
          if (meta) {
            const full = await ipc.invoke('db:draft-get-full', meta.id)
            if (full?.content?.trim()) {
              sampleTexts.push(full.content.trim().slice(0, 2000))
            }
          }
        }
        callbacks.log(t('analyzeStyle.sampledChapters', { count: sampleTexts.length }))
      } catch {
        callbacks.log(t('analyzeStyle.extractFailed'))
        return ''
      }

      if (sampleTexts.length === 0) {
        callbacks.log(t('analyzeStyle.emptySample'))
        return ''
      }
      sampleText = sampleTexts.join('\n\n---\n\n')
    }

    const template = getPromptTemplate('analyze_writing_style')
    if (!template) throw new Error(t('analyzeStyle.templateNotFound'))

    const prompt = new BasePromptBuilder(template)
      // 使用 protected variables 需要通过子类或反射，这里在 build 前手动设置
      ; (prompt as unknown as { variables: { sample_text: string } }).variables = { sample_text: sampleText }
    const finalPrompt = prompt.build()

    callbacks.log(t('analyzeStyle.callingAI'))
    const result = await this.callLLM(
      finalPrompt,
      template.systemRole || '你是一位资深的文学评论家和网文研究者。',
      callbacks,
      undefined,
      context,
    )

    const cleanResult = this.stripThinkingTags(result).trim()
    if (!cleanResult) {
      callbacks.log(t('analyzeStyle.emptyResult'))
      return ''
    }

    // 写入 NovelConfig.styleReference（文风指纹），不覆盖作者手写的 writingStyle
    const { updateNovelConfig, saveProject } = useProjectStore.getState()
    updateNovelConfig({ styleReference: cleanResult })
    await saveProject()
    callbacks.log(t('analyzeStyle.saved'))

    return cleanResult
  }
}
