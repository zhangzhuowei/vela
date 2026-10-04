import i18n from '../../../i18n'
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { callLLMStandalone } from './standalone-llm'
import { useProjectStore } from '../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })
import { getPromptTemplate } from '../../prompt-templates'
import { PostProcessPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'

import {
  runPostProcessPipeline,
  getChapterFinalizeScope,
  stripThinkingTags,
  type PostProcessStep,
} from '../workflow-utils'
import type { ChapterInfo } from '../chapter-workflow'
import {
  extractAndWriteback, runConsistencyGate, buildCanonContext, canonStore,
  ARC_SIZE, arcRangeOf, isArcEnd, formatChapterSummariesForArc, formatArcSummariesForBook,
} from '../../narrative-consistency'
import { parseJSONWithRepair } from '../json-repair'
import { isWorkflowCancelled } from '../workflow-errors'

export interface FinalizeChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterInfo: ChapterInfo
}

// ===== 工具函数：后处理的 LLM 调用 =====

/**
 * 使用 PromptBuilder 调用 LLM，可被 PostProcessStep 的 executor 直接调用。
 * 经 callLLMStandalone 走命令基类：重试退避、备用模型链、调用记账与取消（见 standalone-llm.ts）。
 * purpose 用于用量统计；传入 context 时用户取消能中断进行中的请求。
 */
async function callLLMForPostProcess(
  builder: { build: () => string; getSystemRole: () => string },
  callbacks: StepCallbacks,
  purpose: string,
  options?: { responseFormat?: { type: string } },
  context?: WorkflowContext,
): Promise<string> {
  const raw = await callLLMStandalone(builder.build(), builder.getSystemRole(), callbacks, purpose, options, context)
  return stripThinkingTags(raw)
}

/**
 * 容错 JSON 解析。
 *
 * 先剥离 Markdown 代码块并截取到最外层大括号，再委托共享的 parseJSONWithRepair
 * 走“原样 → 转义裸控制字符 → 转义游离引号 → 两者叠加”修复链。
 */
function parseJSON<T>(text: string): T {
  let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
  const firstBrace = cleanText.indexOf('{')
  const lastBrace = cleanText.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1)
  }
  return parseJSONWithRepair<T>(cleanText)
}

// ===== 后处理步骤构建器 =====

/**
 * 构建章节定稿后处理步骤列表
 *
 * 每个步骤都是独立的 PostProcessStep，由 runPostProcessPipeline
 * 统一调度执行、持久化状态、支持单步重试。
 * 导出供 createRepairFinalizeWorkflow 复用。
 *
 * @param project       当前项目信息
 * @param chapterNumber 章节号
 * @param chapterTitle  章节标题
 * @param draftContent  定稿正文内容
 * @param context       所属工作流的上下文（可选）：传入后用户取消能中断后处理中的模型请求
 */
export function buildFinalizePostProcessSteps(
  _project: { path: string },
  chapterNumber: number,
  chapterTitle: string,
  draftContent: string,
  context?: WorkflowContext,
): PostProcessStep[] {
  const steps: PostProcessStep[] = []

  // ─── 步骤 1: 导入知识库 ───────────────────────────────────────────
  steps.push({
    key: 'kb_import',
    label: t('finalize.kbImport'),
    critical: true,
    executor: async (callbacks) => {
      const contentFileName = chapterTitle
        ? `第${chapterNumber}章 ${chapterTitle}.txt`
        : `chapter_${chapterNumber}.txt`
      const result = await ipc.invoke('kb:import-text', draftContent, contentFileName, _project.path) as { success: boolean; error?: string; chunkCount?: number }
      if (result.success) {
        callbacks.log(t('finalize.kbImportDone', { chunks: result.chunkCount }))
      } else {
        throw new Error(t('finalize.kbImportFailed', { error: result.error }))
      }
    },
  })

  // ─── 步骤 2: 本章剧情要点提取 ─────────────────────────────────────
  const notesTemplate = getPromptTemplate('generate_chapter_notes')
  if (notesTemplate) {
    steps.push({
      key: 'chapter_notes',
      label: t('finalize.chapterNotes'),
      critical: true,
      executor: async (callbacks) => {
        const notesBuilder = new PostProcessPromptBuilder(notesTemplate)
          .withChapterContent(draftContent)
          .withChapterNumber(chapterNumber)
          .withChapterTitle(chapterTitle)

        const cleanNotes = await callLLMForPostProcess(notesBuilder, callbacks, 'FinalizeChapterNotes', undefined, context)

        // 写入蓝图 JSON 的 notes 字段
        await ipc.invoke('db:blueprint-update-notes', chapterNumber, cleanNotes)
        callbacks.log(t('finalize.notesExtracted'))

        // [Canon] 同步写入章节级结构化摘要，供下一次生成引用
        try {
          await ipc.invoke('db:canon-summary-upsert', {
            chapterNumber,
            title: chapterTitle,
            summary: cleanNotes,
            createdAt: new Date().toISOString(),
          })
          callbacks.log('  🛡️ [Canon] 结构化摘要已写入 Canon Store')
        } catch (e) {
          callbacks.log(`  ⚠️ [Canon] 摘要写入失败：${String(e)}`)
        }
      },
    })
  }

  // ─── 步骤 2.5: [Canon] 写回 —— 把本章提取为结构化时间线/角色/事实/剧情线 ────
  steps.push({
    key: 'canon_writeback',
    label: t('finalize.canonWriteback'),
    critical: false,
    executor: async (callbacks) => {
      try {
        const [allChars, blueprint] = await Promise.all([
          ipc.invoke('db:character-get-all').catch(() => [] as Array<{ name: string; role: string; currentState?: { location?: string; powerLevel?: string; physicalState?: string; mentalState?: string; keyItems?: string; recentEvents?: string } }>),
          ipc.invoke('db:blueprint-get', chapterNumber).catch(() => null as null | { keyEvents?: string; characters?: string[]; suspenseHook?: string }),
        ])
        // 取出已生成的 notes 作为摘要来源
        const notes = await ipc.invoke('db:canon-summary-get', chapterNumber).catch(() => null as null | { summary?: string }) || null
        const existingNotes = notes?.summary || ''
        const result = await extractAndWriteback({
          chapterNumber,
          chapterTitle,
          chapterContent: draftContent,
          characters: (allChars || []).map(c => ({
            name: c.name,
            role: c.role,
            currentState: c.currentState,
          })),
          chapterBlueprint: blueprint ? {
            keyEvents: blueprint.keyEvents,
            characters: blueprint.characters,
            suspenseHook: blueprint.suspenseHook,
          } : undefined,
          existingNotes,
        })
        if (result.ok) {
          callbacks.log(t('finalize.canonWritebackSuccess', { events: (blueprint as unknown as { keyEvents?: string })?.keyEvents ? '已抽取' : '见正文' }))
        } else if (result.errors.length > 0) {
          callbacks.log(t('finalize.canonWritebackPartial', { count: result.errors.length, errors: result.errors.slice(0, 3).join('；') }))
        }
      } catch (e) {
        callbacks.log(t('finalize.canonWritebackError', { error: String(e) }))
      }
    },
  })

  // ─── 步骤 2.6: [分层摘要] 每卷最后一章定稿时生成卷摘要，并据各卷摘要刷新全书摘要 ────
  // 取代旧的「每 5 章把最近章节摘要各截 80 字拼成一行」：那样的压缩几乎不含信息，且只在章节很少时才会被读到
  const arcTemplate = getPromptTemplate('generate_arc_summary')
  const bookTemplate = getPromptTemplate('generate_book_summary')
  if (isArcEnd(chapterNumber) && arcTemplate && bookTemplate) {
    steps.push({
      key: 'arc_summary',
      label: t('finalize.arcSummary'),
      critical: false,
      executor: async (callbacks) => {
        try {
          const [from, to] = arcRangeOf(chapterNumber)
          const chapterSummaries = await canonStore.getSummariesInRange(from, to)
          // 本卷一半以上的章节有要点才生成，否则摘要会严重失真
          if (chapterSummaries.length < Math.ceil(ARC_SIZE / 2)) {
            callbacks.log(t('finalize.arcSummarySkip', { from, to, count: chapterSummaries.length }))
            return
          }

          const arcBuilder = new PostProcessPromptBuilder(arcTemplate)
            .withArcRange(from, to)
            .withChapterSummaries(formatChapterSummariesForArc(chapterSummaries))
          const arcText = (await callLLMForPostProcess(arcBuilder, callbacks, 'FinalizeArcSummary', undefined, context)).trim()
          if (!arcText) throw new Error('empty arc summary')
          await canonStore.upsertArcSummary({
            level: 'arc',
            startChapter: from,
            endChapter: to,
            title: t('finalize.arcSummaryTitle', { from, to }),
            summary: arcText,
            createdAt: new Date().toISOString(),
          })
          callbacks.log(t('finalize.arcSummaryDone', { from, to, length: arcText.length }))

          // 全书摘要：由全部卷摘要重新汇总（重写早期某卷时，后面各卷照样计入）
          const arcs = (await canonStore.getArcSummaries()).filter((a) => a.level === 'arc')
          if (arcs.length === 0) return
          const coveredUntil = Math.max(...arcs.map((a) => a.endChapter))
          const bookBuilder = new PostProcessPromptBuilder(bookTemplate)
            .withArcSummaries(formatArcSummariesForBook(arcs), coveredUntil)
          const bookText = (await callLLMForPostProcess(bookBuilder, callbacks, 'FinalizeBookSummary', undefined, context)).trim()
          if (!bookText) throw new Error('empty book summary')
          await canonStore.upsertArcSummary({
            level: 'book',
            startChapter: 1,
            endChapter: coveredUntil,
            title: '',
            summary: bookText,
            createdAt: new Date().toISOString(),
          })
          callbacks.log(t('finalize.bookSummaryDone', { to: coveredUntil, length: bookText.length }))
        } catch (e) {
          // 用户取消要继续往上抛，交给流水线统一处理
          if (isWorkflowCancelled(e)) throw e
          callbacks.log(t('finalize.arcSummaryError', { error: String(e) }))
        }
      },
    })
  }

// ─── 步骤 3: 角色状态更新 ────────────────────────────────────────
  const cardTemplate = getPromptTemplate('update_character_cards')
  if (cardTemplate) {
    steps.push({
      key: 'character_cards',
      label: t('finalize.charStateUpdate'),
      critical: false,
      executor: async (callbacks) => {
        // 读取现有角色卡
        const allChars = (await ipc.invoke('db:character-get-all')) as unknown as Array<Record<string, unknown>>
        const simpleCards = allChars.map((c) => ({ name: c.name, role: c.role }))

        const cardBuilder = new PostProcessPromptBuilder(cardTemplate)
          .withChapterContent(draftContent.slice(0, 5000))
          .withChapterNumber(chapterNumber)
          .withExistingCardsJson(simpleCards)

        const cardsResult = await callLLMForPostProcess(cardBuilder, callbacks, 'FinalizeCharacterCards', { responseFormat: { type: 'json_object' } }, context)
        type LLMUpdateState = {
          location?: string
          powerLevel?: string
          physicalState?: string
          mentalState?: string
          keyItems?: string
          recentEvents?: string
          knownInfo?: string
          speechStyle?: string
        }

        const cardUpdates = parseJSON<{
          updates?: Array<{ name: string; currentState: LLMUpdateState }>
          newCharacters?: Array<{ name: string; role: string; currentState: LLMUpdateState }>
        }>(cardsResult)

        if (cardUpdates.updates && Array.isArray(cardUpdates.updates)) {
          for (const upd of cardUpdates.updates) {
            const dbChar = allChars.find((c) => c.name === upd.name)
            if (dbChar && upd.currentState) {
              const cs = upd.currentState
              const dbCharState = (dbChar.currentState as Record<string, unknown>) || {}
              const newState = {
                location: cs.location || (dbCharState.location as string) || '',
                powerLevel: cs.powerLevel || (dbCharState.powerLevel as string) || '',
                physicalState: cs.physicalState || (dbCharState.physicalState as string) || '',
                mentalState: cs.mentalState || (dbCharState.mentalState as string) || '',
                keyItems: cs.keyItems || (dbCharState.keyItems as string) || '',
                recentEvents: cs.recentEvents || '',
                // 已知信息累积维护：新值优先，否则保留既有（角色不会"忘记"已知情报）
                knownInfo: cs.knownInfo || (dbCharState.knownInfo as string) || '',
                updatedAtChapter: chapterNumber,
              }
              await ipc.invoke('db:character-update-state', upd.name, newState)
              callbacks.log(`✅ 更新角色动态状态: ${dbChar.name}`)

              // 说话风格自动初始化：仅当角色卡尚无口癖档案时才写入，绝不覆盖作者手填
              const existingSpeech = (dbChar.speechStyle as string) || ''
              if (!existingSpeech.trim() && cs.speechStyle && cs.speechStyle.trim()) {
                await ipc.invoke('db:character-update-speech', upd.name, cs.speechStyle.trim())
                callbacks.log(`✅ 初始化角色说话风格: ${dbChar.name}`)
              }
            }
          }
        }

        if (cardUpdates.newCharacters && Array.isArray(cardUpdates.newCharacters)) {
          let newCharCount = 0
          for (const newChar of cardUpdates.newCharacters) {
            if (allChars.some((c) => c.name === newChar.name)) continue
            newCharCount++
            const cs = newChar.currentState || {}
            await ipc.invoke('db:character-upsert', {
              name: newChar.name,
              role: newChar.role || 'supporting',
              gender: '', age: '', appearance: '', personality: '', background: '',
              abilities: '', motivation: '', relationships: '', arc: '', notes: '',
              speechStyle: cs.speechStyle?.trim() || '',
              currentState: {
                location: cs.location || '',
                powerLevel: cs.powerLevel || '',
                physicalState: cs.physicalState || '',
                mentalState: cs.mentalState || '',
                keyItems: cs.keyItems || '',
                recentEvents: cs.recentEvents || '',
                knownInfo: cs.knownInfo || '',
                updatedAtChapter: chapterNumber,
              }
            })
          }
          if (newCharCount > 0) {
            callbacks.log(t('finalize.newCharsRegistered', { count: newCharCount }))
          }
        }
      },
    })
  }

  // ─── 步骤 3.5: 伏笔台账更新（抽取新伏笔 + 标记回收）──────────────────
  const foreshadowTemplate = getPromptTemplate('foreshadow_extract')
  if (foreshadowTemplate) {
    steps.push({
      key: 'foreshadow_track',
      label: '🧵 伏笔台账更新',
      critical: false,
      executor: async (callbacks) => {
        const open = (await ipc.invoke('db:foreshadow-get-open')) as Array<{
          id: number; content: string; plantedChapter: number; expectedChapter: number | null
        }>
        const openSlim = open.map((f) => ({
          id: f.id, content: f.content, plantedChapter: f.plantedChapter, expectedChapter: f.expectedChapter,
        }))

        const builder = new PostProcessPromptBuilder(foreshadowTemplate)
          .withChapterContent(draftContent.slice(0, 6000))
          .withChapterNumber(chapterNumber)
          .withOpenForeshadowings(openSlim)

        const raw = await callLLMForPostProcess(builder, callbacks, 'FinalizeForeshadowing', { responseFormat: { type: 'json_object' } }, context)
        const result = parseJSON<{
          planted?: Array<{ content: string; expectedChapter?: number | null }>
          paidIds?: number[]
        }>(raw)

        let plantedCount = 0
        if (Array.isArray(result.planted)) {
          for (const p of result.planted) {
            if (!p?.content || !p.content.trim()) continue
            await ipc.invoke('db:foreshadow-create', {
              content: p.content.trim(),
              plantedChapter: chapterNumber,
              expectedChapter: p.expectedChapter ?? null,
            })
            plantedCount++
          }
        }
        let paidCount = 0
        if (Array.isArray(result.paidIds)) {
          const openIds = new Set(openSlim.map((f) => f.id))
          for (const id of result.paidIds) {
            if (!openIds.has(id)) continue
            await ipc.invoke('db:foreshadow-mark-paid', id, chapterNumber)
            paidCount++
          }
        }
        callbacks.log(`✅ 伏笔台账更新：新增 ${plantedCount} 条，回收 ${paidCount} 条`)
      },
    })
  }

  // ─── 步骤 4: 文风自动学习（每5章触发一次）─────────────────────────
  if (chapterNumber % 5 === 0) {
    steps.push({
      key: 'style_analysis',
      label: t('finalize.styleLearning'),
      critical: false,
      executor: async (callbacks) => {
        callbacks.log(t('finalize.styleLearningTriggered'))
        const { AnalyzeWritingStyleCommand } = await import('./analyze-style.command')
        await new AnalyzeWritingStyleCommand().execute({
          step: {} as unknown,
          // 独立的 data，但取消状态跟随所属工作流
          context: { data: {}, get cancelled() { return context?.cancelled ?? false } },
          callbacks,
        })
        callbacks.log(t('finalize.styleAnalysisDone'))
      },
    })
  }

  return steps
}

// ===== 定稿命令 =====

export class FinalizeChapterCommand extends BaseWorkflowCommand<void> {
  constructor(private params: FinalizeChapterParams) {
    super()
  }

  async execute({ callbacks, context }: CommandExecuteParams): Promise<void> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const refinedDraftText = this.params.draftContent
    if (!refinedDraftText) throw new Error(t('finalize.noFinalizedContent'))

    callbacks.log('\n' + t('finalize.startFinalize'))

    // 1. 获取对应草稿。一致性 Gate 必须先通过，才能写入 finalized/物理文件。
    const { parseDraftMeta } = await import('../chapter-workflow')
    const dbDraft = await parseDraftMeta(this.params.draftPath)
    if (!dbDraft) throw new Error(t('finalize.internalStateError'))

    // ==========================================
    // [Gate v2] 叙事一致性强制门禁 — 必须在任何定稿写入之前通过
    // ==========================================
    let gatedContent = refinedDraftText
    let blockedReason: string | null = null
    try {
      const [core, allCharacters] = await Promise.all([
        ipc.invoke('db:project-core-get').catch(() => null),
        ipc.invoke('db:character-get-all').catch(() => []),
      ])
      const canon = await buildCanonContext({
        chapterNumber: this.params.chapterNumber,
        architecture: {
          premise: core?.premise || '',
          charactersArch: core?.charactersArch || '',
          worldbuilding: core?.worldbuilding || '',
          synopsis: core?.synopsis || '',
        },
        characters: (allCharacters || []).map((c) => ({
          name: c.name,
          role: c.role,
          currentState: c.currentState,
        })),
        chapterGoal: t('finalize.chapterGoalPrefix', { chapter: this.params.chapterNumber }),
        previousEnding: '',
        ragContext: '',
        writingStyle: project.novelConfig.writingStyle || '',
        globalGuidance: project.novelConfig.globalGuidance || '',
      })
      const gateResult = await runConsistencyGate({
        chapterNumber: this.params.chapterNumber,
        chapterContent: gatedContent,
        canon,
        isRewrite: false,
      })
      callbacks.log(t('canon.finalizeGateVerdict', { verdict: gateResult.verdict, report: gateResult.report }))
      if (gateResult.verdict === 'BLOCK') {
        // 不能在这里直接 return：静默返回会让工作流步骤显示成功、
        // 批量管线继续输出「已定稿」，而章节实际未定稿，下一章才因
        // 前置校验失败报错，问题被掩盖到错误的位置
        blockedReason = gateResult.blockingReasons?.length
          ? gateResult.blockingReasons.join('；')
          : gateResult.report
      }
      if (gateResult.verdict === 'REPAIR' && gateResult.repairedContent) {
        gatedContent = gateResult.repairedContent
        callbacks.log(t('canon.finalizeGateRepaired', { attempts: gateResult.repairAttempts }))
      }
    } catch (e) {
      callbacks.log(t('canon.finalizeGateError', { error: String(e) }))
      throw new Error(t('finalize.gateExecutionFailed', { error: String(e) }))
    }
    if (blockedReason) {
      throw new Error(
        `第${this.params.chapterNumber}章被叙事一致性 Gate 阻止定稿（存在 HIGH 级冲突）：${blockedReason}。` +
        '章节保持未定稿状态，请修复冲突后重新定稿'
      )
    }

    await ipc.invoke('db:draft-update-content', dbDraft.id, gatedContent, gatedContent.length)
    await ipc.invoke('db:draft-update-status', dbDraft.id, 'finalized', gatedContent.length)

    // 【重要】：除了写入 DB，对于已定稿的章节需要实体化为物理文件放在根目录，供外部系统读取或备份
    const safeTitle = this.params.chapterInfo.title ? ` ${this.params.chapterInfo.title.replace(/[/\\]/g, '_')}` : ''
    const physicalPath = `${project.path}/第${this.params.chapterNumber}章${safeTitle}.txt`
    try {
      const titleLine = this.params.chapterInfo.title ? `第${this.params.chapterNumber}章 ${this.params.chapterInfo.title}\n\n` : `第${this.params.chapterNumber}章\n\n`
      const contentToWrite = titleLine + gatedContent.replace(/^#+ .*\n*/, '')
      await ipc.invoke('fs:write-file', physicalPath, contentToWrite)
    } catch (e) {
      callbacks.log(t('finalize.fileWriteFailed', { error: String(e) }))
    }

    callbacks.log(t('finalize.finalizedSaved', { chapter: this.params.chapterNumber, title: safeTitle }))

    // 3. 通过 PostProcessPipeline 执行后处理（状态持久化 + 支持重试）
    callbacks.log(t('finalize.launchingPostProcess'))

    const scope = getChapterFinalizeScope(this.params.chapterNumber)
    const sourceLabel = t('finalize.chapterGoalPrefix', { chapter: this.params.chapterNumber })
    const steps = buildFinalizePostProcessSteps(
      project,
      this.params.chapterNumber,
      this.params.chapterInfo.title,
      gatedContent,
      context,
    )

    await runPostProcessPipeline(project.path, scope, sourceLabel, steps, callbacks)

    callbacks.log('\n' + t('finalize.chapterComplete', { chapter: this.params.chapterNumber }))
    useProjectStore.getState().refreshFileTree()

    // 通过 EventBus 通知 ProjectService 执行定稿后的统一刷新
    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('FINALIZE_COMPLETE', { chapterNumber: this.params.chapterNumber })
  }
}
