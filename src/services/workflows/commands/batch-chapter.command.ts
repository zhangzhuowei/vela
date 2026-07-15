import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { ipc } from '../../ipc-client'
import { guardChapterWriting } from '../../workflow-guards'
import type { ChapterInfo } from '../chapter-workflow'

/**
 * 批量无人值守管线 —— 单章子管线编排（设计文档 #3）
 *
 * 对单章顺序执行：前置校验 → 写稿 →（可选）审校闭环 →（可选）去AI味 → 定稿(含后处理)。
 * 全程复用现有 Command，不重写生成/审稿/定稿逻辑。
 * 由 createBatchGenerateWorkflow 为每章生成一个 step 来驱动。
 */

export interface BatchOptions {
  /** 是否插入自动审校闭环（质量门） */
  autoReview: boolean
  /** 审校闭环最多轮数 */
  reviewMaxRounds: number
  /** 审校门控：error（默认）| error+warning */
  reviewGate: 'error' | 'error+warning'
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
  /** 是否插入去AI味 */
  deaify: boolean
  /** 去AI味强度 */
  deaifyIntensity: '轻' | '中' | '重'
  /** 审校未通过时的策略：stop=停止批量；continue=带问题继续定稿 */
  onReviewFail: 'stop' | 'continue'
  /** 断点续跑：跳过已定稿章节 */
  resume: boolean
  /** 按任务派模型（为空走默认模型）：写稿/审校/去AI味 */
  models?: { write?: string; review?: string; deaify?: string }
}

export class BatchChapterCommand extends BaseWorkflowCommand<string> {
  constructor(
    private chapterNumber: number,
    private opts: BatchOptions,
  ) {
    super()
  }

  async execute(execParams: CommandExecuteParams): Promise<string> {
    const { callbacks, context } = execParams
    const n = this.chapterNumber
    const ensureNotCancelled = () => {
      if (context.cancelled) throw new Error('工作流已取消')
    }

    ensureNotCancelled()

    // 0. 断点续跑：已定稿则跳过
    if (this.opts.resume) {
      const finalized = await ipc.invoke('db:draft-get-finalized', n)
      if (finalized) {
        callbacks.log(`⏭ 第${n}章已定稿，跳过`)
        return `第${n}章：跳过（已定稿）`
      }
    }

    // 1. 前置校验（复用护栏：前一章须已定稿且后处理通过，保证上下文不断裂）
    const guard = await guardChapterWriting(n)
    if (!guard.ok) throw new Error(`第${n}章前置校验失败：${guard.message ?? '未知原因'}`)

    // 2. 加载蓝图 → ChapterInfo
    const bp = await ipc.invoke('db:blueprint-get', n)
    if (!bp) throw new Error(`第${n}章蓝图缺失，请先生成章节蓝图`)
    const chapterInfo: ChapterInfo = {
      chapterNumber: n,
      title: bp.title || `第${n}章`,
      role: bp.role || '',
      purpose: bp.purpose || '',
      characters: Array.isArray(bp.characters) ? bp.characters : [],
      keyEvents: bp.keyEvents || '',
      suspenseHook: bp.suspenseHook || undefined,
      userGuidance: bp.userGuidance || undefined,
    }

    // 3. 写稿（复用 GenerateDraftCommand，草稿路径经 context.data 传出）
    ensureNotCancelled()
    callbacks.log(`\n📝 第${n}章「${chapterInfo.title}」写稿...`)
    const { GenerateDraftCommand } = await import('./generate-draft.command')
    await new GenerateDraftCommand(chapterInfo, this.opts.models?.write, true).execute(execParams)
    let draftPath = context.data.draftPath as string | undefined
    let draftContent = context.data.draftContent as string | undefined
    if (!draftPath || !draftContent) throw new Error(`第${n}章写稿未产出有效草稿`)

    // 4. 审校闭环（质量门）
    let reviewPassed = true
    if (this.opts.autoReview) {
      ensureNotCancelled()
      callbacks.log(`🔁 第${n}章审校闭环...`)
      const { AutoReviewLoopCommand } = await import('./auto-review-loop.command')
      const loop = new AutoReviewLoopCommand({
        chapterNumber: n,
        chapterTitle: chapterInfo.title,
        draftPath,
        draftContent,
        maxRounds: this.opts.reviewMaxRounds,
        gate: this.opts.reviewGate,
        reviewFocus: this.opts.reviewFocus,
        reviewModelId: this.opts.models?.review,
        silent: true,
      })
      await loop.execute(execParams)
      if (loop.result) {
        draftPath = loop.result.finalDraftPath
        draftContent = loop.result.finalContent
        reviewPassed = loop.result.passed
      }
    }

    // 5. 质量门判定
    if (this.opts.autoReview && !reviewPassed) {
      if (this.opts.onReviewFail === 'stop') {
        throw new Error(`第${n}章审校未通过（残留阻断级问题），已按策略停止批量`)
      }
      callbacks.log(`⚠️ 第${n}章审校未完全通过，按策略「继续」带问题定稿`)
    }

    // 6. 去AI味（无人值守：静默生成 + 自动合并为新版本）
    if (this.opts.deaify) {
      ensureNotCancelled()
      callbacks.log(`✨ 第${n}章去AI味（强度：${this.opts.deaifyIntensity}）...`)
      const { DeaifyCommand } = await import('./deaify.command')
      const deaify = new DeaifyCommand({
        chapterNumber: n,
        draftPath,
        draftContent,
        intensity: this.opts.deaifyIntensity,
        silent: true,
        modelId: this.opts.models?.deaify,
      })
      await deaify.execute(execParams)
      const cleaned = deaify.lastRefinedContent
      const revId = deaify.lastRevisionId
      if (cleaned && revId !== undefined) {
        const version = await ipc.invoke('db:draft-next-version', n)
        const created = await ipc.invoke('db:draft-create', {
          chapterNumber: n,
          version,
          source: 'rewrite',
          content: cleaned,
          wordCount: cleaned.length,
        })
        if (created.success && created.id !== undefined) {
          await ipc.invoke('db:revision-mark-merged', revId, created.id)
          draftPath = `vela://draft/${created.id}`
          draftContent = cleaned
          callbacks.log(`   已合并去AI味结果为 v${version}`)
        }
      }
    }

    // 7. 定稿 + 后处理（复用 FinalizeChapterCommand，含 KB/章节要点/角色卡更新）
    ensureNotCancelled()
    callbacks.log(`✅ 第${n}章定稿...`)
    const { FinalizeChapterCommand } = await import('./finalize-chapter.command')
    await new FinalizeChapterCommand({
      draftPath,
      draftContent,
      chapterNumber: n,
      chapterInfo: { chapterNumber: n, title: chapterInfo.title, role: '', purpose: '', characters: [], keyEvents: '' },
    }).execute(execParams)

    const summary = reviewPassed
      ? `🎉 第${n}章已定稿`
      : `⚠️ 第${n}章已定稿（带残留问题，建议人工复核）`
    callbacks.log(summary)
    return summary
  }
}
