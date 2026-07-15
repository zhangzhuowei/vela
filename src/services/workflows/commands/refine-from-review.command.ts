import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'


export interface RefineFromReviewParams {
  draftPath: string
  draftContent: string
  reviewReport: string
  reviewFileName?: string
  chapterNumber: number
  userRefinePrompt?: string
  /** 静默模式：为 true 时不打开 diff Tab（供自动审校闭环批量调用） */
  silent?: boolean
  /** 指定本次调用使用的模型（按任务派模型）；为空走默认模型 */
  modelId?: string
}

export class RefineFromReviewCommand extends BaseWorkflowCommand<string> {
  /** 最近一次执行生成的修订稿 id（供自动闭环读取以合并版本） */
  lastRevisionId?: number
  /** 最近一次执行生成的清洗后修订正文（供自动闭环读取） */
  lastRefinedContent?: string

  constructor(private params: RefineFromReviewParams) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    callbacks.log('正在根据审稿报告精准修复...')

    const template = getPromptTemplate('refine_from_review')
    if (!template) throw new Error('未找到审稿修复模板')

    const userPromptBlock = this.params.userRefinePrompt?.trim()
      ? `★【用户额外修稿指导（绝对优先级）】★：\n${this.params.userRefinePrompt}`
      : ''

    const promptBuilder = new ChapterPromptBuilder(template)
      .withReviewReport(this.params.reviewReport)
      .withDraftContent(this.params.draftContent)
      .withGlobalGuidance(project.novelConfig.globalGuidance || '')
      .withUserRefinePrompt(userPromptBlock)

    const refined = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, undefined, this.params.modelId)
    const cleanRefined = this.stripThinkingTags(refined)

    const { parseDraftMeta } = await import('../chapter-workflow')
    const baseDraft = await parseDraftMeta(this.params.draftPath)
    if (!baseDraft) throw new Error('找不到基准草稿版本')

    const revIndex = await ipc.invoke('db:revision-next-index', baseDraft.id)

    // 清理该草稿下已有的 pending 状态修稿，保证只保留最新的一条
    const pendingRevs = await ipc.invoke('db:revision-get-pending', baseDraft.id)
    for (const rev of pendingRevs) {
      await ipc.invoke('db:revision-mark-discarded', rev.id)
    }

    const createRes = await ipc.invoke('db:revision-create', {
      baseDraftId: baseDraft.id,
      revisionIndex: revIndex,
      revisionType: 'review-fix',
      content: cleanRefined,
      wordCount: cleanRefined.length,
      userPrompt: this.params.userRefinePrompt,
    }) as { success: boolean; id: number }

    // 暴露给自动审校闭环：修订 id + 清洗后正文
    this.lastRevisionId = createRes.id
    this.lastRefinedContent = cleanRefined

    if (!this.params.silent) {
      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: `diff-${this.params.draftPath}-${createRes.id}`,
        name: `审稿修复：第${this.params.chapterNumber}章`,
        type: 'diff',
        filePath: this.params.draftPath,
        originalContent: this.params.draftContent,
        content: cleanRefined,
        revisionPath: String(createRes.id),
        chapterNumber: this.params.chapterNumber,
        chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
      })
    }

    callbacks.log(`✅ 审稿修复完成（${cleanRefined.length} 字），已生成修订稿版本 r${revIndex}`)
    return refined
  }
}
