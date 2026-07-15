import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'


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

  async execute({ callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    let sampleText = ''

    if (this.sampleText?.trim()) {
      // 来源 A：作者粘贴的样章文本
      callbacks.log('📖 使用作者提供的样章文本分析文风...')
      sampleText = this.sampleText.trim().slice(0, 12000)
    } else {
      // 来源 B：采样本项目最近 5 章定稿正文
      callbacks.log('📖 正在采样已有章节正文...')
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
        callbacks.log(`  已采样 ${sampleTexts.length} 章正文`)
      } catch {
        callbacks.log('⚠️ 提取定稿内容失败')
        return ''
      }

      if (sampleTexts.length === 0) {
        callbacks.log('⚠️ 采样文本为空，跳过文风分析')
        return ''
      }
      sampleText = sampleTexts.join('\n\n---\n\n')
    }

    const template = getPromptTemplate('analyze_writing_style')
    if (!template) throw new Error('未找到文风分析模板')

    const prompt = new BasePromptBuilder(template)
      // 使用 protected variables 需要通过子类或反射，这里在 build 前手动设置
      ; (prompt as unknown as { variables: { sample_text: string } }).variables = { sample_text: sampleText }
    const finalPrompt = prompt.build()

    callbacks.log('🎨 调用 AI 提炼文风特征...')
    const result = await this.callLLM(
      finalPrompt,
      template.systemRole || '你是一位资深的文学评论家和网文研究者。',
      callbacks,
    )

    const cleanResult = this.stripThinkingTags(result).trim()
    if (!cleanResult) {
      callbacks.log('⚠️ 文风分析返回空结果')
      return ''
    }

    // 写入 NovelConfig.styleReference（文风指纹），不覆盖作者手写的 writingStyle
    const { updateNovelConfig, saveProject } = useProjectStore.getState()
    updateNovelConfig({ styleReference: cleanResult })
    await saveProject()
    callbacks.log('✅ 文风指纹已保存（写稿时会自动注入）')

    return cleanResult
  }
}
