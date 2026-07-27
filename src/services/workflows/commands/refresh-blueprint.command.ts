import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { RefreshBlueprintPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import {
  readArchitectureText,
  readCharacterStatesText,
  readChapterNotesTimeline,
  readPreviousEnding,
  buildAntiRepetitionText,
  buildOpenForeshadowingText,
  buildFutureBlueprintsText,
} from '../workflow-utils'
import type { ChapterInfo } from '../chapter-workflow'

/** 蓝图刷新结果 */
export interface RefreshBlueprintResult {
  /** 刷新后（或原样）的章节信息，可直接交给写稿命令 */
  chapterInfo: ChapterInfo
  /** AI 是否实际改动了蓝图 */
  changed: boolean
  /** 改动理由（或无需改动的理由） */
  reason: string
}

/** AI 返回的蓝图修正结果 */
interface RefreshPayload {
  changed?: boolean
  changeReason?: string
  title?: string
  role?: string
  purpose?: string
  characters?: unknown
  keyEvents?: string
  suspenseHook?: string
}

/**
 * 滚动蓝图刷新 —— 写稿前把静态蓝图修正为贴合实际剧情进度的可执行方案
 *
 * 背景：章节蓝图是开写前一次性规划的（依据架构 + 前序蓝图的计划条目），
 * 它从未见过真正写出来的正文。批量连写时直接消费这份过期蓝图，误差逐章累积，
 * 表现为「越写越飘」，用户只能逐章手工修蓝图。
 *
 * 本命令在写稿前插入一步：把已定稿正文要点、上一章结尾、角色当前状态、
 * 未回收伏笔、反雷同信息、后续蓝图与节奏位置一起交给模型，产出修正后的本章蓝图。
 *
 * 防跑偏设计：
 * - role（本章在主线中的功能定位）强制回写为原值，模型无权更改；
 * - userGuidance / notes / notesUpdatedAt 原样保留，不丢用户微操与已回填要点；
 * - 刷新失败一律降级为「沿用原蓝图」，绝不阻断写稿。
 */
export class RefreshBlueprintCommand extends BaseWorkflowCommand<RefreshBlueprintResult> {
  /** 刷新结果（供批量管线取用） */
  public result?: RefreshBlueprintResult

  constructor(
    private chapterNumber: number,
    private modelId?: string,
  ) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<RefreshBlueprintResult> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    const n = this.chapterNumber
    const bp = await ipc.invoke('db:blueprint-get', n)
    if (!bp) throw new Error(`第${n}章蓝图缺失，请先生成章节蓝图`)

    /** 原蓝图对应的 ChapterInfo（任何异常都降级回退到它） */
    const fallback: ChapterInfo = {
      chapterNumber: n,
      title: bp.title || `第${n}章`,
      role: bp.role || '',
      purpose: bp.purpose || '',
      characters: Array.isArray(bp.characters) ? bp.characters : [],
      keyEvents: bp.keyEvents || '',
      suspenseHook: bp.suspenseHook || undefined,
      userGuidance: bp.userGuidance || undefined,
    }

    const template = getPromptTemplate('refresh_chapter_blueprint')
    if (!template) {
      callbacks.log('⚠️ 未找到「滚动蓝图刷新」模板，沿用原蓝图')
      return this.finish(fallback, false, '模板缺失，沿用原蓝图')
    }

    // 第 1 章没有已写正文可参照，刷新无意义
    if (n <= 1) {
      callbacks.log('ℹ️ 第1章无前文可参照，沿用原蓝图')
      return this.finish(fallback, false, '开篇章无前文，沿用原蓝图')
    }

    callbacks.log(`🧭 第${n}章蓝图滚动刷新：聚合已写剧情与当前状态...`)

    // ===== 聚合「已经写出来的事实」 =====
    const [
      architecture,
      timeline,
      previousEnding,
      characterStates,
      foreshadowing,
      antiRepetition,
      futureBlueprints,
    ] = await Promise.all([
      readArchitectureText(),
      readChapterNotesTimeline(n),
      readPreviousEnding(n),
      readCharacterStatesText(),
      buildOpenForeshadowingText(n),
      buildAntiRepetitionText(n),
      buildFutureBlueprintsText(n),
    ])

    const builder = new RefreshBlueprintPromptBuilder(template)
      .withChapterNumber(n)
      .withNumberOfChapters(project.novelConfig.totalChapters || 0)
      .withOriginalBlueprint({
        chapterNumber: n,
        title: fallback.title,
        role: fallback.role,
        purpose: fallback.purpose,
        characters: fallback.characters,
        keyEvents: fallback.keyEvents,
        suspenseHook: fallback.suspenseHook || '',
      })
      .withNovelArchitecture(architecture)
      .withGlobalSummary(timeline)
      .withPreviousEnding(previousEnding)
      .withCharacterStates(characterStates)
      .withForeshadowing(foreshadowing)
      .withAntiRepetition(antiRepetition)
      .withFutureBlueprints(futureBlueprints)
      .withGlobalGuidance(project.novelConfig.globalGuidance || '（无特殊要求）')
      // 节奏指导来自工作流参数（与目录生成一致），非 novelConfig 字段
      .withPacingGuidance((context.data.pacingGuidance as string) || '')

    let payload: RefreshPayload
    try {
      const raw = await this.callLLMWithBuilder(
        builder,
        callbacks,
        { responseFormat: { type: 'json_object' } },
        context,
        this.modelId,
      )
      payload = this.parseJSON<RefreshPayload>(raw)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 用户取消要向上传播，其余一律降级沿用原蓝图，绝不阻断写稿
      if (msg.includes('取消')) throw e
      callbacks.log(`⚠️ 蓝图刷新失败，沿用原蓝图：${msg}`)
      return this.finish(fallback, false, `刷新失败，沿用原蓝图：${msg}`)
    }

    const changed = payload.changed === true
    const reason = (payload.changeReason || '').trim() || (changed ? '已按实际剧情进度修正' : '原蓝图仍然适用')

    if (!changed) {
      callbacks.log(`  ✅ 蓝图无需调整：${reason}`)
      return this.finish(fallback, false, reason)
    }

    // ===== 合并结果：role 锚定，空字段回退原值 =====
    const characters = Array.isArray(payload.characters)
      ? (payload.characters as unknown[]).map((c) => String(c).trim()).filter(Boolean)
      : fallback.characters

    const refreshed: ChapterInfo = {
      chapterNumber: n,
      // role 强制锚定为原值：主线功能定位不允许被改写
      role: fallback.role,
      title: (payload.title || '').trim() || fallback.title,
      purpose: (payload.purpose || '').trim() || fallback.purpose,
      keyEvents: (payload.keyEvents || '').trim() || fallback.keyEvents,
      suspenseHook: (payload.suspenseHook || '').trim() || fallback.suspenseHook,
      characters: characters.length > 0 ? characters : fallback.characters,
      // 用户微操指导原样保留
      userGuidance: fallback.userGuidance,
    }

    if (payload.role && payload.role.trim() && payload.role.trim() !== fallback.role) {
      callbacks.log(`  🔒 模型试图把 role 从「${fallback.role}」改为「${payload.role.trim()}」，已按主线锚定拒绝`)
    }

    // ===== 写回数据库 =====
    // userGuidance / notes / notesUpdatedAt 原样回填，不丢用户微操与已回填要点。
    // 写回失败不影响本次写稿——刷新结果已在返回值里。
    try {
      await ipc.invoke('db:blueprint-upsert', {
        chapterNumber: n,
        title: refreshed.title,
        role: refreshed.role,
        purpose: refreshed.purpose,
        keyEvents: refreshed.keyEvents,
        characters: refreshed.characters,
        suspenseHook: refreshed.suspenseHook || '',
        userGuidance: bp.userGuidance || '',
        notes: bp.notes || '',
        notesUpdatedAt: bp.notesUpdatedAt || '',
      })
      this.notifyRefresh(['blueprints'])
      callbacks.log(`  💾 已更新第${n}章蓝图`)
    } catch (e) {
      callbacks.log(`  ⚠️ 蓝图写回失败（本次写稿仍使用刷新结果）：${String(e)}`)
    }

    callbacks.log(`  🔄 蓝图已刷新：${reason}`)
    callbacks.log(`     标题：${refreshed.title}`)
    callbacks.log(`     关键事件：${refreshed.keyEvents.slice(0, 80)}${refreshed.keyEvents.length > 80 ? '…' : ''}`)

    return this.finish(refreshed, true, reason)
  }

  private finish(chapterInfo: ChapterInfo, changed: boolean, reason: string): RefreshBlueprintResult {
    this.result = { chapterInfo, changed, reason }
    return this.result
  }
}
