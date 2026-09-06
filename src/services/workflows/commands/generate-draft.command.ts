import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import {
  DIR_PROMPTS
} from '../../../shared/project-paths'
import type { ChapterInfo } from '../chapter-workflow'
import type { CharacterData } from '../../../../electron/repositories/character-repository'
import type { ProjectCoreData } from '../../../../electron/repositories/project-core-repository'
import {
  buildCanonContext,
  renderCanonContext,
  runConsistencyGate,
} from '../../narrative-consistency'
import i18n from '../../../i18n'
import {
  type ChapterEnding,
  isChapterEnding,
  resolveChapterEnding,
} from '../../chapter-ending'
import { stripEditorialMarkers } from '../../prose-clean'
import { loadSettingDigest } from '../../setting-bible-service'

export class GenerateDraftCommand extends BaseWorkflowCommand {
  protected attachModGuidance = true
  private endingMode: ChapterEnding = 'cliffhanger'
  protected modScope() {
    return { chapterNumber: this.chapterInfo.chapterNumber }
  }

  constructor(private chapterInfo: ChapterInfo, private modelId?: string, private silent = false) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(i18n.t('common.noProject', { ns: 'commands' }))

    callbacks.log(i18n.t('generateDraft.assemblingContext', { ns: 'commands' }))

    // 核心设定与角色卡各读一次，供架构拼装、Canon 构建、状态档案、口癖上下文复用
    //（原实现同一次写稿中 db:project-core-get 与 db:character-get-all 各要往返 2~3 次）
    const core = await ipc.invoke('db:project-core-get')
    const architecture = this.assembleArchitecture(core)
    const projectPrompts = await this.readProjectPrompts(project.path)
    const mergedGuidance = [project.novelConfig.globalGuidance || '', projectPrompts].filter(Boolean).join('\n\n')

    const allCharacters: CharacterData[] = await ipc.invoke('db:character-get-all').catch(() => [])
    const characterState = this.formatCharacterStateArchive(allCharacters)
    let futureBlueprintsStr = '（无后续蓝图）'
    try {
      const { loadDirectoryBlueprints } = await import('../directory-workflow')
      const allBlueprints = await loadDirectoryBlueprints()
      const futureBlueprintsArr = allBlueprints.filter(
        b => b.chapterNumber > this.chapterInfo.chapterNumber && b.chapterNumber <= this.chapterInfo.chapterNumber + 5
      )
      if (futureBlueprintsArr.length > 0) {
        futureBlueprintsStr = futureBlueprintsArr.map(b => i18n.t('generateDraft.futureBlueprintLine', { ns: 'commands', chapter: b.chapterNumber, title: b.title, events: b.keyEvents })).join('\n')
      }
    } catch { /* 忽略 */ }

    // ==========================================
    // [Canon] 构造叙事一致性 Canon Context（所有生成路径都强制经过此闸门）
    // ==========================================
    let canonRendered = ''
    let canonForValidation: import('../../narrative-consistency').CanonContext | null = null
    try {
      canonForValidation = await buildCanonContext({
        chapterNumber: this.chapterInfo.chapterNumber,
        architecture: {
          premise: core?.premise ?? '',
          charactersArch: core?.charactersArch ?? '',
          worldbuilding: core?.worldbuilding ?? '',
          synopsis: core?.synopsis ?? '',
        },
        characters: allCharacters.map(c => ({
          name: c.name,
          role: c.role,
          currentState: c.currentState,
        })),
        chapterGoal: typeof this.chapterInfo === 'object' ? JSON.stringify(this.chapterInfo) : String(this.chapterInfo),
        previousEnding: '', // 下面在非首章分支填充
        ragContext: '',     // 下面在非首章分支填充
        writingStyle: project.novelConfig.writingStyle || '',
        globalGuidance: mergedGuidance,
      })
      canonRendered = renderCanonContext(canonForValidation)
      callbacks.log(i18n.t('generateDraft.canonContextInjected', { ns: 'commands', timeline: canonForValidation.timeline.length, characters: canonForValidation.characterStates.length, plotLines: canonForValidation.openPlotLines.length }))
    } catch (e) {
      callbacks.log(i18n.t('generateDraft.canonContextFailed', { ns: 'commands', error: String(e) }))
    }
    // 目标字数：优先本章覆盖值，其次全局「每章字数」
    const targetWords = Number(this.chapterInfo.wordsTarget) || Number(project.novelConfig.wordsPerChapter) || 0
    callbacks.log(`  📏 本章目标字数：${targetWords || '未设置'}${this.chapterInfo.wordsTarget ? '（本章覆盖）' : '（全局配置）'}`)

    const isFirstChapter = this.chapterInfo.chapterNumber === 1
    const templateKey = isFirstChapter ? 'first_chapter_draft' : 'next_chapter_draft'
    const template = getPromptTemplate(templateKey)
    if (!template) throw new Error(i18n.t('common.templateNotFound', { ns: 'commands', key: templateKey }))

    // ==========================================
    // Prompt 构建——按「稳定前缀 → 可变后缀」排列
    // 以最大化 LLM 上下文缓存命中率
    // ==========================================
    const promptBuilder = new ChapterPromptBuilder(template)
      // ---- 缓存命中区（跨章稳定，前缀对齐）----
      .withArchitecture(architecture)
      .withSettingDigest(await loadSettingDigest())
      .withGlobalGuidance(mergedGuidance)
      .withWritingStyle(project.novelConfig.writingStyle || '')
      .withStyleReference(project.novelConfig.styleReference || '')
      .withNovelConfig(project.novelConfig)
      // 单章目标字数优先于全局「每章字数」
      .withWordNumber(targetWords)
      // 本章任务三件套：首章与后续章节模板都引用这三个变量。
      //（此前只在非首章分支注入，首章 prompt 里残留字面 {{chapter_info}} 等占位符，
      // 模型看不到本章任务、后续预告与作者微操）
      .withChapterInfo(this.chapterInfo)
      .withFutureBlueprints(futureBlueprintsStr)
      .withUserGuidance(this.chapterInfo.userGuidance?.trim() || '（无微操指导）')

    this.endingMode = await this.resolveEndingMode(project.novelConfig.chapterEnding)
    promptBuilder.withEndingGuidance(
      i18n.t(
        this.endingMode === 'smooth' ? 'chapterEnding.guidanceSmooth' : 'chapterEnding.guidanceCliffhanger',
        { ns: 'commands' },
      ),
    )
    callbacks.log(
      i18n.t('chapterEnding.resolved', {
        ns: 'commands',
        mode: i18n.t(
          this.endingMode === 'smooth' ? 'chapterEnding.smooth' : 'chapterEnding.cliffhanger',
          { ns: 'commands' },
        ),
      }),
    )

    if (!isFirstChapter) {
      // 从蓝图 JSON 的 notes 字段读取章节要点时间线（一次取回全部蓝图，避免逐章 IPC）
      const { readChapterNotesTimeline } = await import('../workflow-utils')
      const chapterTimeline = await readChapterNotesTimeline(this.chapterInfo.chapterNumber)
      callbacks.log(`  📋 已加载章节要点时间线（${chapterTimeline.length} 字）`)

      // 近 3 章定稿正文一次并行读回：上一章结尾与反雷同速览共用同一份数据
      //（原实现串行逐章读，且上一章全文要读两遍）
      const recentContents = await this.readRecentFinalizedContents(this.chapterInfo.chapterNumber, 3)
      const previousEnding = stripEditorialMarkers(recentContents.get(this.chapterInfo.chapterNumber - 1) || '').slice(-1000)

      let filteredContext = ''
      try {
        callbacks.log(i18n.t('generateDraft.searchingKB', { ns: 'commands' }))
        let searchQuery = `${this.chapterInfo.title} ${this.chapterInfo.keyEvents} ${this.chapterInfo.characters.join(' ')}`
        if (this.chapterInfo.knowledgeQueryHint?.trim()) {
          searchQuery += ` ${this.chapterInfo.knowledgeQueryHint.trim()}`
          callbacks.log(i18n.t('generateDraft.addedKeywords', { ns: 'commands', keywords: this.chapterInfo.knowledgeQueryHint.trim() }))
        }
        const results = await ipc.invoke('kb:search', searchQuery, 5)
        filteredContext = results.length > 0
          ? results.map((r: { fileName: string; score: number; text: string }, i: number) => i18n.t('generateDraft.kbResultLine', { ns: 'commands', index: i + 1, file: r.fileName, score: (r.score * 100).toFixed(0), text: r.text })).join('\n\n')
          : i18n.t('generateDraft.kbNoContent', { ns: 'commands' })
      } catch {
        filteredContext = i18n.t('generateDraft.kbUnavailable', { ns: 'commands' })
      }

      const foreshadowText = await this.buildForeshadowingContext(this.chapterInfo.chapterNumber)
      const antiRepText = this.buildAntiRepetitionContext(recentContents)
      const voiceText = this.buildCharacterVoiceContext(this.chapterInfo.characters, allCharacters)

      promptBuilder
        // ---- 缓存命中区续（要点时间线按序追加，前缀对齐）----
        .withGlobalSummary(chapterTimeline)
        // 角色状态已并入 Canon 上下文（canon 合并态是角色卡的超集）；
        // 仅在 Canon 构造失败时回退为角色卡档案，避免同一份状态在 prompt 里出现两遍
        .withCharacterStates(canonRendered ? '（见上方 Canon 上下文 · 当前人物状态）' : characterState)
        // ---- 缓存失效区（逐章变化）----
        .withPreviousEnding(previousEnding || '（无前文）')
        .withFilteredContext(filteredContext)
        .withForeshadowing(foreshadowText)
        .withAntiRepetition(antiRepText)
        .withCharacterVoices(voiceText)
        .withShortSummary('')

      // [Canon] RAG 与上一章结尾就绪后回填到 Canon 对象，供生成后一致性 Gate 使用。
      // 渲染文本不再携带这两项（模板已有专属槽位），无需重渲染
      if (canonForValidation) {
        canonForValidation.previousEnding = previousEnding || '（无前文）'
        canonForValidation.ragContext = filteredContext || '（无 RAG 检索结果）'
      }
    }

    // [Canon] 注入叙事一致性上下文（强制最高优先级）
    if (canonRendered) {
      promptBuilder.withCanonContext(canonRendered)
    }

    // Token 预算管控：中文约 1.5 字符/token，预留 4K 给输出
    const prompt = promptBuilder.build()
    const estimatedTokens = Math.ceil(prompt.length / 1.5)
    const TOKEN_BUDGET = 28000
    if (estimatedTokens > TOKEN_BUDGET) {
      callbacks.log(i18n.t('generateDraft.tokenBudgetWarning', { ns: 'commands', tokens: estimatedTokens, budget: TOKEN_BUDGET }))
    }

    callbacks.log(i18n.t('generateDraft.callingAI', { ns: 'commands' }))

    const draftText = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, undefined, this.modelId)
    let cleanDraftText = this.stripThinkingTags(draftText)

    // ==========================================
    // 篇幅闸门：字数低于下限时自动续写补足
    // ==========================================
    cleanDraftText = await this.ensureWordCount(
      cleanDraftText,
      targetWords,
      promptBuilder.getSystemRole(),
      callbacks,
      context,
    )

    // ==========================================
    // [Canon] 生成后一致性 Gate + 自动修复
    // ==========================================
    let finalDraft = cleanDraftText
    if (canonForValidation) {
      try {
        const gateResult = await runConsistencyGate({
          chapterNumber: this.chapterInfo.chapterNumber,
          chapterContent: cleanDraftText,
          canon: canonForValidation,
        })
        callbacks.log(`  🛡️ [Gate] ${gateResult.verdict}: ${gateResult.report}`)
        if (gateResult.verdict === 'BLOCK') {
          throw new Error(i18n.t('generateDraft.gateBlocked', { ns: 'commands', reasons: gateResult.blockingReasons.join('；') }))
        }
        if (gateResult.verdict === 'REPAIR' && gateResult.repairedContent) {
          finalDraft = gateResult.repairedContent
          callbacks.log(i18n.t('generateDraft.canonAutoRepair', { ns: 'commands', attempts: gateResult.repairAttempts }))
        }
        if (gateResult.issues.length === 0) {
          callbacks.log(i18n.t('generateDraft.canonCheckPassed', { ns: 'commands' }))
        }
        const remaining = gateResult.issues.map(i => i.issue)
        if (remaining.length > 0) context.data.consistencyWarnings = remaining
        context.data.consistencyReport = {
          verdict: gateResult.verdict,
          totalIssues: gateResult.issues.length,
          repairAttempts: gateResult.repairAttempts,
          remaining: gateResult.issues.length,
        }
      } catch (e) {
        callbacks.log(i18n.t('generateDraft.canonGateError', { ns: 'commands', error: String(e) }))
        throw e
      }
    }

    // 落于数据库
    const nextVersion: number = await ipc.invoke('db:draft-next-version', this.chapterInfo.chapterNumber)
    const createResult = await ipc.invoke('db:draft-create', {
      chapterNumber: this.chapterInfo.chapterNumber,
      version: nextVersion,
      source: 'write',
      content: finalDraft,
      wordCount: this.countWords(finalDraft),
    })

    const pseudoPath = createResult.id ? `vela://draft/${createResult.id}` : `vela://draft/ch${this.chapterInfo.chapterNumber}/v${nextVersion}`

    context.data.draft = finalDraft
    context.data.draftContent = finalDraft
    context.data.draftPath = pseudoPath
    context.data.chapterNumber = this.chapterInfo.chapterNumber
    context.data.chapterInfo = this.chapterInfo
    context.data.mergedGuidance = mergedGuidance
    context.data.shortSummary = ''

    // 新草稿只影响本章：只刷新本章草稿列表，不做全库重载。
    // 批量静默连写时原实现每章都要全量 loadAllDrafts + refreshFileTree，
    // IPC 次数随章节数平方级增长
    try {
      const { useDraftStore } = await import('../../../stores/draft-store')
      await useDraftStore.getState().loadChapterDrafts(this.chapterInfo.chapterNumber)
    } catch { /* 忽略 */ }
    if (!this.silent) {
      useProjectStore.getState().refreshFileTree()
    }

    if (!this.silent) {
      try {
        const { useEditorStore } = await import('../../../stores/editor-store')
        useEditorStore.getState().openFile({
          id: pseudoPath,
          name: `第${this.chapterInfo.chapterNumber}章 ${this.chapterInfo.title} v${nextVersion}`,
          type: 'chapter',
          filePath: pseudoPath,
          content: finalDraft,
        })
      } catch { /* 忽略 */ }
    }

    callbacks.log(`✅ 草稿已自动入库保存为版本 v${nextVersion}（${this.countWords(finalDraft)} 字）`)
    return finalDraft
  }

  /** 正文字数统计：忽略空白字符，与"中文字数"的直观认知对齐 */
  private countWords(text: string): number {
    return (text || '').replace(/\s/g, '').length
  }

  /**
   * 篇幅闸门：草稿字数低于目标下限时，自动发起续写补足（最多 2 轮）。
   *
   * 背景：写稿模板对字数只有"大约 N 字左右"的弱约束，且紧邻多条反注水指令，
   * 模型会系统性写短；而原链路对字数不做任何校验，短稿会直接入库。
   * 走"续写补足"而非"整篇重写"，是为了保住第一轮已经写好的文笔与细节。
   */
  private async ensureWordCount(
    draft: string,
    targetWords: number,
    systemRole: string,
    callbacks: CommandExecuteParams['callbacks'],
    context: CommandExecuteParams['context'],
  ): Promise<string> {
    if (!targetWords || targetWords <= 0) return draft

    const floor = Math.round(targetWords * 0.9)
    const MAX_ROUNDS = 2
    let result = draft

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const current = this.countWords(result)
      if (current >= floor) {
        if (round === 1) callbacks.log(`  📏 篇幅校验通过：${current} 字（目标 ${targetWords} / 下限 ${floor}）`)
        return result
      }

      const gap = targetWords - current
      callbacks.log(`  📏 篇幅不足：${current} 字 < 下限 ${floor} 字，自动续写补足约 ${gap} 字（第 ${round}/${MAX_ROUNDS} 轮）...`)

      const continuePrompt = `你正在完成一章尚未写完的小说正文。下面是本章已经写好的部分，它的篇幅不足，需要你直接续写下去。

【本章写作方向】
${typeof this.chapterInfo === 'object' ? JSON.stringify(this.chapterInfo, null, 2) : String(this.chapterInfo)}

【本章已写好的部分（全文）】
${result}

【续写要求】
1. 直接从上文的最后一句往下接着写，不要重写开头，不要复述或改写上文已有的任何段落，不要写"（续）"之类的标记。
2. 需要补足约 ${gap} 字，使本章总字数达到 ${targetWords} 字左右。
3. 补足篇幅的方式是把本章既定情节的每个节拍写足：补足场景的五感细节、角色的动作与微表情、对白的来回交锋与言外之意、主角的即时心理判断。严禁靠设定科普、无关寒暄、重复同一信息点来凑字数，更不许把后续章节的情节提前写进来。
4. 如果上文末尾已经像是一个收尾，请把它当作本章中途的一个停顿，继续往下推进剧情。
5. ${i18n.t(
        this.endingMode === 'smooth' ? 'chapterEnding.continueSmooth' : 'chapterEnding.continueCliffhanger',
        { ns: 'commands' },
      )}
6. 只输出续写的正文纯文本，不要 Markdown 符号，对话用中文双引号，段落之间保留一个空行。`

      let added = ''
      try {
        added = this.stripThinkingTags(
          await this.callLLM(continuePrompt, systemRole, callbacks, undefined, context, this.modelId)
        )
      } catch (e) {
        callbacks.log(`  ⚠️ 续写补足失败，保留当前篇幅：${String(e)}`)
        return result
      }

      if (this.countWords(added) < 50) {
        callbacks.log('  ⚠️ 续写返回内容过少，停止补足')
        return result
      }

      result = `${result.trimEnd()}\n\n${added.trim()}`
      const after = this.countWords(result)
      callbacks.log(`  📏 补足后 ${after} 字${after >= floor ? '，已达标' : ''}`)
      if (after >= floor) return result
    }

    callbacks.log(`  ⚠️ 已达最大补足轮次，最终 ${this.countWords(result)} 字（目标 ${targetWords}）`)
    return result
  }

  /** 加载未回收伏笔，格式化为写稿上下文（到期伏笔会标注提醒本章回收） */
  private async buildForeshadowingContext(currentChapter: number): Promise<string> {
    try {
      const { formatOpenForeshadowings } = await import('../workflow-utils')
      const open = await ipc.invoke('db:foreshadow-get-open')
      return formatOpenForeshadowings(open, currentChapter)
    } catch {
      return '（暂无未回收伏笔）'
    }
  }

  /**
   * 一次并行读回最近 windowSize 章的定稿正文。
   * 上一章结尾与反雷同速览共用这份数据，避免同一章正文经 IPC 读两遍。
   */
  private async readRecentFinalizedContents(currentChapter: number, windowSize: number): Promise<Map<number, string>> {
    const result = new Map<number, string>()
    const nums: number[] = []
    for (let i = Math.max(1, currentChapter - windowSize); i < currentChapter; i++) nums.push(i)
    await Promise.all(nums.map(async (n) => {
      try {
        const meta = await ipc.invoke('db:draft-get-finalized', n)
        if (!meta) return
        const full = await ipc.invoke('db:draft-get-full', meta.id)
        const content = full?.content?.trim()
        if (content) result.set(n, content)
      } catch { /* 忽略单章读取失败 */ }
    }))
    return result
  }

  /**
   * 跨章反雷同：提炼最近数章的开场句与断章句，供本章规避雷同的起笔/转场/断章。
   */
  private buildAntiRepetitionContext(recentContents: Map<number, string>): string {
    const lines = Array.from(recentContents.keys())
      .sort((a, b) => a - b) // 由早到近
      .map((i) => {
        const content = recentContents.get(i) as string
        const opening = content.slice(0, 55).replace(/\s+/g, ' ')
        const closing = content.slice(-45).replace(/\s+/g, ' ')
        return `- 第${i}章 开场：「${opening}…」｜断章：「…${closing}」`
      })
    if (lines.length === 0) return '（暂无往期章节可参考）'
    return lines.join('\n')
  }

  /** 出场角色说话风格：从角色卡取本章出场角色中已填写口癖的，注入以保对白辨识度 */
  private buildCharacterVoiceContext(names: string[], allChars: CharacterData[]): string {
    if (!names || names.length === 0) return '（未指定出场角色）'
    const nameSet = new Set(names.map((n) => n.trim()).filter(Boolean))
    const lines = allChars
      .filter((c) => nameSet.has(c.name) && (c.speechStyle || '').trim())
      .map((c) => `- ${c.name}：${(c.speechStyle || '').trim()}`)
    return lines.length > 0
      ? lines.join('\n')
      : '（出场角色暂无说话风格档案，请自行赋予各角色有辨识度、彼此区分的对白）'
  }

  private async resolveEndingMode(book: unknown): Promise<ChapterEnding> {
    if (isChapterEnding(this.chapterInfo.chapterEnding)) {
      return resolveChapterEnding(book, this.chapterInfo.chapterEnding)
    }
    try {
      const bp = await ipc.invoke('db:blueprint-get', this.chapterInfo.chapterNumber)
      return resolveChapterEnding(book, bp?.chapterEnding)
    } catch {
      return resolveChapterEnding(book, undefined)
    }
  }

  /** 把项目核心设定四段拼装为全书架构文本（premise/charactersArch/worldbuilding/synopsis 顺序） */
  private assembleArchitecture(core: ProjectCoreData | null): string {
    const parts: string[] = []
    if (core?.premise) parts.push(core.premise.trim())
    if (core?.charactersArch) parts.push(core.charactersArch.trim())
    if (core?.worldbuilding) parts.push(core.worldbuilding.trim())
    if (core?.synopsis) parts.push(core.synopsis.trim())
    return parts.join('\n\n---\n\n')
  }

  private async readProjectPrompts(projectPath: string): Promise<string> {
    try {
      const files = await ipc.invoke('fs:list-dir', `${projectPath}/${DIR_PROMPTS}`)
      const mdFiles = files.filter((f: { isDir: boolean; name: string }) => !f.isDir && f.name.endsWith('.md'))
      if (mdFiles.length === 0) return ''
      const parts: string[] = []
      for (const f of mdFiles) {
        const result = await ipc.invoke('fs:read-file', f.path)
        if (result.success && result.content.trim()) {
          parts.push(`${i18n.t('generateDraft.projectGuidanceHeading', { ns: 'commands', name: f.name.replace(/\.md$/, '') })}\n${result.content.trim()}`)
        }
      }
      return parts.join('\n\n')
    } catch { return '' }
  }

  /** 把角色卡格式化为角色状态档案文本（Canon 构造失败时的回退注入源） */
  private formatCharacterStateArchive(allChars: CharacterData[]): string {
    const states: string[] = []
    for (const card of allChars) {
      if (card.name && card.currentState) {
        const cs = card.currentState
        states.push(
          `${card.name}（${card.role || '未知'}）| ` +
          `境界：${cs.powerLevel || '未知'} | ` +
          `位置：${cs.location || '未知'} | ` +
          `身体：${cs.physicalState || '正常'} | ` +
          `心理：${cs.mentalState || '正常'} | ` +
          `道具：${cs.keyItems || '无'} | ` +
          `已知：${cs.knownInfo || '—'} | ` +
          `最近：第${cs.updatedAtChapter || 0}章 ${cs.recentEvents || ''}`
        )
      }
    }
    return states.length > 0 ? `【角色状态档案】\n${states.join('\n')}` : '（暂无角色状态档案）'
  }
}
