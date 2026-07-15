import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'

/**
 * 去 AI 味润色 Pass（设计文档 #2 Tier 1）
 *
 * 对一章草稿做"表达层"去 AI 味清洗：消除段尾升华、比喻词滥用、万能过渡、
 * 机械排比、情绪解说、播音腔对话等 AI 特征，同时保持情节/人设/篇幅不变。
 * 复用 refine_from_review 的落库方式：结果存为一条 revision（类型 refine，
 * userPrompt 标记为 [去AI味]），可打开 diff 供人工合并，或 silent 供批量管线调用。
 */

export interface DeaifyParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  /** 清洗强度：轻/中/重，默认 中 */
  intensity?: '轻' | '中' | '重'
  /** 静默模式：为 true 时不打开 diff Tab（供批量管线调用） */
  silent?: boolean
  /** 指定本次调用使用的模型（按任务派模型）；为空走默认模型 */
  modelId?: string
}

export class DeaifyCommand extends BaseWorkflowCommand<string> {
  /** 最近一次执行生成的修订稿 id（供批量管线合并） */
  lastRevisionId?: number
  /** 最近一次执行生成的清洗后正文 */
  lastRefinedContent?: string

  constructor(private params: DeaifyParams) {
    super()
  }

  async execute({ callbacks, context }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    const draft = this.params.draftContent
    if (!draft) throw new Error('无草稿内容')

    callbacks.log(`正在进行去 AI 味润色（强度：${this.params.intensity ?? '中'}）...`)

    const template = getPromptTemplate('deaify_polish')
    if (!template) throw new Error('未找到去AI味模板')

    const builder = new ChapterPromptBuilder(template)
      .withDraftContent(draft)
      .withWritingStyle(project.novelConfig.writingStyle || '')
      .withIntensity(this.params.intensity ?? '中')

    const cleaned = this.stripThinkingTags(
      await this.callLLMWithBuilder(builder, callbacks, undefined, context, this.params.modelId),
    )
    if (!cleaned) {
      callbacks.log('⚠️ 去AI味未产出有效内容')
      return ''
    }

    const { parseDraftMeta } = await import('../chapter-workflow')
    const baseDraft = await parseDraftMeta(this.params.draftPath)
    if (!baseDraft) throw new Error('找不到基准草稿版本')

    const revIndex = await ipc.invoke('db:revision-next-index', baseDraft.id)

    // 清理该草稿下已有的 pending 修稿，只保留最新一条
    const pendingRevs = await ipc.invoke('db:revision-get-pending', baseDraft.id)
    for (const rev of pendingRevs) {
      await ipc.invoke('db:revision-mark-discarded', rev.id)
    }

    const createRes = await ipc.invoke('db:revision-create', {
      baseDraftId: baseDraft.id,
      revisionIndex: revIndex,
      revisionType: 'refine',
      content: cleaned,
      wordCount: cleaned.length,
      userPrompt: '[去AI味]',
    }) as { success: boolean; id: number }

    this.lastRevisionId = createRes.id
    this.lastRefinedContent = cleaned

    if (!this.params.silent) {
      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: `diff-${this.params.draftPath}-${createRes.id}`,
        name: `去AI味：第${this.params.chapterNumber}章`,
        type: 'diff',
        filePath: this.params.draftPath,
        originalContent: this.params.draftContent,
        content: cleaned,
        revisionPath: String(createRes.id),
        chapterNumber: this.params.chapterNumber,
        chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
      })
    }

    callbacks.log(`✅ 去AI味完成（${cleaned.length} 字），已生成修订稿 r${revIndex}`)
    return cleaned
  }
}
