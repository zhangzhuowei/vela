import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ReviewPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { buildCanonContext, renderCanonContext } from '../../narrative-consistency'
import i18n from '../../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })


export interface ReviewChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
  /** 静默模式：为 true 时不打开审稿报告 Tab（供自动审校闭环批量调用） */
  silent?: boolean
  /** 指定本次调用使用的模型（按任务派模型）；为空走默认模型 */
  modelId?: string
}

export class ReviewChapterCommand extends BaseWorkflowCommand<string> {
  constructor(private params: ReviewChapterParams) {
    super()
  }

  async execute({ callbacks, context }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const draft = this.params.draftContent
    if (!draft) throw new Error(t('common.noDraftContent'))

    callbacks.log(t('reviewChapter.preparingReview'))
    callbacks.log(t('reviewChapter.searchingArchives'))

    // 使用向量检索获取与待审章节相关的历史上下文（替代全局摘要）
    let contextSummary = t('reviewChapter.noContextReference')
    try {
      // 从待审内容中提取前 200 字作为检索 query
      const queryText = draft.slice(0, 200)
      const results = await ipc.invoke('kb:search', queryText, 5)
      if (results.length > 0) {
        contextSummary = results
          .map((r: { fileName: string; score: number; text: string }, i: number) =>
            t('generateDraft.kbResultLine', { index: i + 1, file: r.fileName, score: (r.score * 100).toFixed(0), text: r.text }))
          .join('\n\n')
      }
    } catch {
      contextSummary = t('reviewChapter.kbUnavailable')
    }

    const template = getPromptTemplate('consistency_check')
    if (!template) throw new Error(t('reviewChapter.templateNotFound'))

    const foreshadowText = await this.buildForeshadowingContext(this.params.chapterNumber)

    // ==========================================
    // [Canon] 注入叙事一致性上下文 — 审稿员交叉验证事实基线
    // Canon 的合并人物状态与正史设定是角色卡/世界观的超集，注入成功时
    // 模板槽位只留指引文本，不再把同一份内容在 prompt 里重复一遍；
    // 仅在 Canon 构造失败时回退为直读角色卡与世界观（各多一次 IPC）。
    // ==========================================
    const promptBuilder = new ReviewPromptBuilder(template)
    let characterState = '（已并入「已确立事实基线」· 当前人物状态）'
    let worldBuilding = '（已并入「已确立事实基线」· 正史设定）'
    try {
      const [core, allCharacters] = await Promise.all([
        ipc.invoke("db:project-core-get").catch(() => null),
        ipc.invoke("db:character-get-all").catch(() => []),
      ]);
      const canon = await buildCanonContext({
        chapterNumber: this.params.chapterNumber,
        architecture: {
          premise: core?.premise || "",
          charactersArch: core?.charactersArch || "",
          worldbuilding: core?.worldbuilding || "",
          synopsis: core?.synopsis || "",
        },
        characters: (allCharacters || []).map(c => ({
          name: c.name,
          role: c.role,
          currentState: c.currentState,
        })),
        chapterGoal: `第${this.params.chapterNumber}章审稿`,
        previousEnding: "",
        ragContext: "",
        writingStyle: project.novelConfig.writingStyle || "",
        globalGuidance: project.novelConfig.globalGuidance || "",
      });
      promptBuilder.withCanonContext(renderCanonContext(canon));
      callbacks.log(t('canon.reviewContextInjected', { timeline: canon.timeline.length, characters: canon.characterStates.length }));
    } catch (e) {
      characterState = await this.readCharacterStates()
      worldBuilding = await this.readWorldBuilding()
      callbacks.log(`  ⚠️ [Canon] 审稿上下文构造失败，已回退为直读角色卡/世界观：${String(e)}`);
    }

    promptBuilder
      .withChapterContent(draft)
      .withCharacterStates(characterState)
      .withGlobalSummary(contextSummary)
      .withWorldBuilding(worldBuilding)
      .withReviewFocus(this.params.reviewFocus || '')
      .withForeshadowing(foreshadowText)

    callbacks.log(t('reviewChapter.callingReviewer'))

    // 期望 JSON 格式返回
    const reviewResultRaw = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { responseFormat: { type: 'json_object' } },
      // 传入 context：用户取消时能中断正在进行的流
      context,
      this.params.modelId
    )

    const reviewResultClean = this.stripThinkingTags(reviewResultRaw)

    const { parseDraftMeta } = await import('../chapter-workflow')
    const baseDraft = await parseDraftMeta(this.params.draftPath)
    if (!baseDraft) throw new Error(t('common.baseDraftNotFound'))
    const baseVersion = baseDraft.version

    const revIndex = await ipc.invoke('db:review-next-index', baseDraft.id)

    let parsedResult
    try {
      parsedResult = this.parseJSON(reviewResultClean)
    } catch {
      callbacks.log(t('reviewChapter.parseFailed'))
      parsedResult = { summary: t('reviewChapter.parseFallback'), items: [] }
    }

    await ipc.invoke('db:review-create', {
      baseDraftId: baseDraft.id,
      reviewIndex: revIndex,
      content: JSON.stringify(parsedResult, null, 2),
    })

    // 将审稿报告 JSON 序列化为字符串，作为 content 传给 Tab
    // EditorArea 渲染 ReviewReport 的条件：activeTab.content 存在
    const reportContent = JSON.stringify(parsedResult, null, 2)

    if (!this.params.silent) {
      const { useEditorStore } = await import('../../../stores/editor-store')
      const pseudoReviewPath = `vela://draft/ch${this.params.chapterNumber}/v${baseVersion}/review${revIndex}`
      useEditorStore.getState().openFile({
        id: `review-${this.params.draftPath}-${revIndex}`,
        name: `审稿报告：第${this.params.chapterNumber}章`,
        type: 'review-report',
        content: reportContent,
        filePath: this.params.draftPath,
        reportPath: pseudoReviewPath,
        reviewReport: reportContent,
        chapterNumber: this.params.chapterNumber,
      })
    }

    callbacks.log(t('reviewChapter.completed', { version: revIndex }))
    return reviewResultClean
  }

  private async readCharacterStates(): Promise<string> {
    try {
      const allChars = await ipc.invoke('db:character-get-all')
      const states: string[] = []
      for (const card of allChars) {
        if (card.name && card.currentState) {
          const cs = card.currentState
          states.push(`${card.name}（${card.role || '未知'}）: ${cs.powerLevel || ''}, ${cs.location || ''}, ${cs.physicalState || ''}, ${cs.mentalState || ''}, 已知：${cs.knownInfo || '—'}, 最近：${cs.recentEvents || ''}`)
        }
      }
      return states.length > 0 ? states.join('\n') : t('reviewChapter.noData')
    } catch { return t('reviewChapter.readFailed') }
  }

  private async readWorldBuilding(): Promise<string> {
    const core = await ipc.invoke('db:project-core-get')
    return core?.worldbuilding || t('reviewChapter.noData')
  }

  /** 加载未回收伏笔，供审稿核对"伏笔完整性"（带注入上限） */
  private async buildForeshadowingContext(currentChapter: number): Promise<string> {
    try {
      const { formatOpenForeshadowings } = await import('../workflow-utils')
      const open = await ipc.invoke('db:foreshadow-get-open')
      return formatOpenForeshadowings(open, currentChapter)
    } catch {
      return '（暂无未回收伏笔）'
    }
  }
}
