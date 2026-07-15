import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { ReviewChapterCommand } from './review-chapter.command'
import { RefineFromReviewCommand } from './refine-from-review.command'
import { ipc } from '../../ipc-client'

/**
 * 自动审校 → 重写 闭环（设计文档 #1）
 *
 * 复用现有的 ReviewChapterCommand（审稿，返回带 severity 的结构化 JSON）
 * 与 RefineFromReviewCommand（按审稿报告修复），把二者串成自动闭环：
 *   审稿 → 若存在阻断级问题 → 修复 → 合并为新草稿版本 → 再审稿 → …
 *   最多 maxRounds 轮，通过（无阻断级问题）或达上限才停。
 *
 * 合并复用现有 IPC：db:draft-next-version + db:draft-create + db:revision-mark-merged，
 * 不新增数据表、不新增 IPC 通道。
 */

export interface ReviewItem {
  category: string
  severity: 'error' | 'warning' | 'pass'
  quote?: string
  description: string
}

export interface ReviewResult {
  items: ReviewItem[]
  summary: string
}

export interface AutoReviewLoopParams {
  chapterNumber: number
  chapterTitle?: string
  draftPath: string
  draftContent: string
  /** 最多循环轮数（每轮 = 一次审稿 +（若不通过）一次修复+合并），默认 3 */
  maxRounds?: number
  /** 门控：error=仅严重矛盾算不通过（默认）；error+warning=严格模式 */
  gate?: 'error' | 'error+warning'
  /** 审稿维度侧重点（透传给 ReviewChapterCommand） */
  reviewFocus?: string
  /** 审稿/修复使用的模型（按任务派模型）；为空走默认模型 */
  reviewModelId?: string
  /** 静默模式：为 true 时结束后不自动打开审稿报告/草稿 Tab（供批量无人值守调用） */
  silent?: boolean
}

export interface AutoReviewLoopResult {
  passed: boolean
  /** 实际执行的审稿轮数 */
  rounds: number
  /** 实际执行的「修复+合并」次数 */
  revised: number
  /** 最终草稿版本路径（可能与输入不同） */
  finalDraftPath: string
  /** 最终草稿正文 */
  finalContent: string
  /** 最后一轮审稿结果 */
  lastReview?: ReviewResult
}

/** 统计阻断级问题数量 */
export function blockingCount(r: ReviewResult, gate: 'error' | 'error+warning'): number {
  if (!r || !Array.isArray(r.items)) return 0
  return r.items.filter(
    (it) => it.severity === 'error' || (gate === 'error+warning' && it.severity === 'warning'),
  ).length
}

export class AutoReviewLoopCommand extends BaseWorkflowCommand<string> {
  /** 执行结果（供批量管线等程序化读取） */
  result?: AutoReviewLoopResult

  constructor(private params: AutoReviewLoopParams) {
    super()
  }

  async execute(execParams: CommandExecuteParams): Promise<string> {
    const { callbacks, context } = execParams
    const maxRounds = Math.max(1, this.params.maxRounds ?? 3)
    const gate = this.params.gate ?? 'error'

    let currentPath = this.params.draftPath
    let currentContent = this.params.draftContent
    let passed = false
    let revised = 0
    let roundsRun = 0
    let prevBlock = Number.POSITIVE_INFINITY
    let lastReview: ReviewResult | undefined

    for (let round = 1; round <= maxRounds; round++) {
      if (context.cancelled) throw new Error('工作流已取消')
      roundsRun = round
      const isLastRound = round === maxRounds

      // 1. 审稿（复用，静默：闭环内不刷一堆报告 Tab）
      callbacks.log(`\n🔁 第 ${round}/${maxRounds} 轮审稿...`)
      const reviewCmd = new ReviewChapterCommand({
        draftPath: currentPath,
        draftContent: currentContent,
        chapterNumber: this.params.chapterNumber,
        reviewFocus: this.params.reviewFocus,
        silent: true,
        modelId: this.params.reviewModelId,
      })
      const reviewRaw = await reviewCmd.execute(execParams)

      let review: ReviewResult
      try {
        review = this.parseJSON<ReviewResult>(reviewRaw)
      } catch {
        review = { items: [], summary: '审稿结果解析失败' }
      }
      lastReview = review

      const errCount = blockingCount(review, 'error')
      const warnCount = Array.isArray(review.items)
        ? review.items.filter((i) => i.severity === 'warning').length
        : 0
      const block = blockingCount(review, gate)
      callbacks.log(`   审稿结果：error=${errCount} warning=${warnCount}（门控=${gate}，阻断=${block}）`)

      // 2. 门控判定
      if (block === 0) {
        passed = true
        callbacks.log(`✅ 第 ${round} 轮通过审校门控（无阻断级问题），闭环结束`)
        break
      }

      // 3. 末轮不再修（避免留下未复审的改动）
      if (isLastRound) {
        callbacks.log(`⚠️ 已达最多 ${maxRounds} 轮，仍有 ${block} 个阻断级问题，返回当前版本`)
        break
      }

      // 3.5 连续无改善提前停止：上一轮修复没能减少阻断级问题 → 判定为难以自动修复，交人工
      if (round > 1 && block >= prevBlock) {
        callbacks.log(`⚠️ 本轮修复未减少阻断级问题（${prevBlock} → ${block}），判定为难以自动修复，提前停止`)
        break
      }
      prevBlock = block

      // 4. 审稿修复（复用，静默）
      callbacks.log(`   发现 ${block} 个阻断级问题，自动修复...`)
      const refineCmd = new RefineFromReviewCommand({
        draftPath: currentPath,
        draftContent: currentContent,
        reviewReport: reviewRaw,
        chapterNumber: this.params.chapterNumber,
        silent: true,
        modelId: this.params.reviewModelId,
      })
      await refineCmd.execute(execParams)

      const refinedContent = refineCmd.lastRefinedContent
      const revisionId = refineCmd.lastRevisionId
      if (!refinedContent || revisionId === undefined) {
        callbacks.log('⚠️ 修复未产出有效结果，终止闭环')
        break
      }

      // 5. 合并修订 → 新草稿版本（组合已有 IPC，见设计文档 #1 §3）
      const nextVersion = await ipc.invoke('db:draft-next-version', this.params.chapterNumber)
      const created = await ipc.invoke('db:draft-create', {
        chapterNumber: this.params.chapterNumber,
        version: nextVersion,
        source: 'rewrite',
        content: refinedContent,
        wordCount: refinedContent.length,
      })
      if (!created.success || created.id === undefined) {
        throw new Error(`合并修订失败：${created.error ?? '无法创建新草稿版本'}`)
      }
      await ipc.invoke('db:revision-mark-merged', revisionId, created.id)

      currentPath = `vela://draft/${created.id}`
      currentContent = refinedContent
      revised++
      callbacks.log(`   ✅ 已合并为新草稿 v${nextVersion}（${refinedContent.length} 字），进入下一轮复审`)
    }

    // 通知草稿抽屉/资产树刷新
    this.notifyRefresh(['drafts'])

    this.result = {
      passed,
      rounds: roundsRun,
      revised,
      finalDraftPath: currentPath,
      finalContent: currentContent,
      lastReview,
    }

    // 残留待人工处理的问题清单（未通过时）
    if (!passed && lastReview && Array.isArray(lastReview.items)) {
      const errs = lastReview.items.filter((i) => i.severity === 'error')
      if (errs.length > 0) {
        callbacks.log('   仍需人工处理的问题：')
        errs.forEach((e, i) => callbacks.log(`   ${i + 1}. [${e.category}] ${e.description}`))
      }
    }

    // 自动打开最终审稿报告 + 最终草稿版本（消除"看起来没变化"的困惑）
    // 静默模式（批量无人值守）下跳过，避免刷出大量 Tab
    if (!this.params.silent) try {
      const { useEditorStore } = await import('../../../stores/editor-store')
      const store = useEditorStore.getState()
      if (lastReview) {
        const reportContent = JSON.stringify(lastReview, null, 2)
        store.openFile({
          id: `review-${currentPath}-loop`,
          name: `审稿报告：第${this.params.chapterNumber}章（终轮）`,
          type: 'review-report',
          content: reportContent,
          filePath: currentPath,
          reviewReport: reportContent,
          chapterNumber: this.params.chapterNumber,
        })
      }
      // 产生了新版本才打开最终草稿（DraftEditor 通过 vela://draft/ 前缀路由）；最后打开使其激活
      if (revised > 0) {
        store.openFile({
          id: currentPath,
          name: `第${this.params.chapterNumber}章 ${this.params.chapterTitle ?? ''} · 审校后`,
          type: 'chapter',
          filePath: currentPath,
          content: currentContent,
          chapterNumber: this.params.chapterNumber,
        })
      }
    } catch (e) {
      callbacks.log(`（提示：自动打开结果失败，可在左侧草稿列表手动查看最新版本）${String(e)}`)
    }

    const verdict = passed ? '通过' : '未完全通过（残留阻断级问题）'
    const summary = `审校闭环结束：${verdict}，共 ${roundsRun} 轮审稿、${revised} 次修复。最终草稿：${currentPath}`
    callbacks.log(`\n${passed ? '🎉' : '⚠️'} ${summary}`)
    return summary
  }
}
