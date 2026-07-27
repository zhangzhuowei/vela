/**
 * 工作流共享工具函数
 *
 * 供 architecture-workflow / chapter-workflow 等多个工作流复用的通用逻辑
 *
 * 核心组件：
 * 1. withRetry — 通用异步重试包装器
 * 2. PostProcessPipeline — 后处理流水线（注册 → 执行 → 持久化 → 修复）
 */

import type { StepCallbacks } from '../../stores/workflow-store'
import type { CharacterData } from '../../../electron/repositories/character-repository'
import { ipc } from '../ipc-client'

// ===== 角色卡资产合并（重新提取时保留已积累字段） =====

/**
 * 重新提取角色卡（架构/导入推演）时，把库中已有、但提取结果不含的「运行期字段」并回，
 * 避免用一份只含静态档案的提取结果直接 save-all 抹掉这些数据。
 *
 * 保留字段（提取结果为空才回退到库中已有值，从而不丢已积累数据）：
 *  - speechStyle  说话风格/口癖（定稿时自动推断，或用户手动填写）
 *  - imagePrompt  角色专属文生图提示词（用户手动填写，提取结果不含此字段）
 *  - portraitPath 文生图人设图路径
 *  - currentState 角色动态状态快照（位置/境界/身体·心理状态/关键道具/最近事件/已知信息，定稿时累积）
 *
 * 静态档案字段（外貌、性格、背景等）仍以提取结果为准，实现「刷新档案但不丢已生成/已积累资产」。
 * 取不到库中角色（首次提取/查询失败）时按原样返回，不影响正常写入。
 */
export async function mergePreservedCharacterAssets(extracted: CharacterData[]): Promise<CharacterData[]> {
  let existing: CharacterData[] = []
  try {
    existing = await ipc.invoke('db:character-get-all')
  } catch { /* 查询失败则按纯提取结果写入 */ }
  if (!Array.isArray(existing) || existing.length === 0) return extracted

  const byName = new Map(existing.map((c) => [c.name, c]))
  return extracted.map((card) => {
    const prev = byName.get(card.name)
    if (!prev) return card
    return {
      ...card,
      speechStyle: card.speechStyle || prev.speechStyle || '',
      imagePrompt: card.imagePrompt || prev.imagePrompt || '',
      portraitPath: card.portraitPath || prev.portraitPath || '',
      currentState: card.currentState ?? prev.currentState,
    }
  })
}

// ===== 文本处理通用工具 =====

/**
 * 剥除文本中可能包含的 <think>...</think> 思维链标签
 * 用于清洗大模型在生成正文时输出的思维链，避免其被持久化写入磁盘文件
 */
export function stripThinkingTags(text: string): string {
  if (!text) return text
  // 支持只有 <think> 没有闭合标签的情况
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}

// ===== 未回收伏笔注入格式化（带上限） =====

export interface OpenForeshadowing {
  id: number
  content: string
  plantedChapter: number
  expectedChapter: number | null
}

/**
 * 把未回收伏笔格式化为写稿/审稿的注入上下文，并施加注入上限，
 * 避免长篇里未回收伏笔越积越多、撑大 prompt 稀释重点。
 *
 * 优先级：① 已到期（expected<=current）② 有预期未到期（越近越前）③ 无预期（越新埋越前）。
 * 超出 maxItems 的较早/低优先伏笔折叠为一行计数提示。
 *
 * @param open          未回收伏笔列表
 * @param currentChapter 当前章节号（用于判定"已到期"）
 * @param maxItems      注入上限，默认 12 条
 */
export function formatOpenForeshadowings(
  open: OpenForeshadowing[] | null | undefined,
  currentChapter: number,
  maxItems = 12,
): string {
  if (!open || open.length === 0) return '（暂无未回收伏笔）'

  const priorityOf = (f: OpenForeshadowing): number => {
    if (f.expectedChapter != null && f.expectedChapter <= currentChapter) return 0 // 已到期
    if (f.expectedChapter != null) return 1 // 有预期未到期
    return 2 // 无预期
  }

  const sorted = [...open].sort((a, b) => {
    const pa = priorityOf(a), pb = priorityOf(b)
    if (pa !== pb) return pa - pb
    // 有预期：按预期回收章升序（越急越前）；无预期：按埋设章降序（越新越前）
    if (pa <= 1) return (a.expectedChapter ?? 0) - (b.expectedChapter ?? 0)
    return b.plantedChapter - a.plantedChapter
  })

  const shown = sorted.slice(0, Math.max(1, maxItems))
  const hidden = sorted.length - shown.length

  const lines = shown.map((f) => {
    const due = f.expectedChapter ? `预期第${f.expectedChapter}章回收` : '回收章未定'
    const overdue = f.expectedChapter != null && f.expectedChapter <= currentChapter
      ? ' 【已到期，本章应考虑回收】'
      : ''
    return `- (#${f.id}) ${f.content}（第${f.plantedChapter}章埋下，${due}）${overdue}`
  })
  if (hidden > 0) {
    lines.push(`- …另有 ${hidden} 条较早的未回收伏笔（暂略，可在「伏笔台账」查看）`)
  }
  return lines.join('\n')
}

// ===== 通用重试包装器 =====

/**
 * 带重试的异步操作包装器
 * @param fn 要执行的异步函数
 * @param maxRetries 最大重试次数（不含首次执行）
 * @param label 操作标签（用于日志）
 * @param callbacks 步骤回调（用于输出日志）
 * @returns 成功返回 { ok: true }，全部失败返回 { ok: false, error }
 */
export async function withRetry(
  fn: () => Promise<void>,
  maxRetries: number,
  label: string,
  callbacks: StepCallbacks,
): Promise<{ ok: boolean; error?: string; attempts: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn()
      return { ok: true, attempts: attempt + 1 }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (attempt < maxRetries) {
        callbacks.log(`  ⚠️ ${label} 第${attempt + 1}次失败，正在重试...（${errMsg}）`)
      } else {
        return { ok: false, error: errMsg, attempts: attempt + 1 }
      }
    }
  }
  return { ok: false, error: '未知错误', attempts: maxRetries + 1 }
}

// ===== 后处理流水线 =====

/** 单个后处理步骤定义 */
export interface PostProcessStep {
  /** 唯一标识，如 'chapter_notes' */
  key: string
  /** 展示名称，如 '📋 章节要点' */
  label: string
  /** 关键步骤（失败阻断下游工作流） */
  critical: boolean
  /** 步骤执行器 */
  executor: (callbacks: StepCallbacks) => Promise<void>
}

/** 单步后处理执行结果（持久化到状态文件） */
export interface PostProcessStepResult {
  label: string
  critical: boolean
  ok: boolean
  completedAt?: string
  error?: string
  lastAttemptAt: string
  attemptCount: number
}

/** 后处理状态（持久化到 .vela/post_process/{scope}.json） */
export interface PostProcessStatus {
  /** 唯一标识，如 'chapter_1_finalize' */
  scope: string
  /** 来源描述，如 '第1章定稿' */
  sourceLabel: string
  /** 首次执行时间 */
  createdAt: string
  /** 最后更新时间 */
  updatedAt: string
  /** 各步骤执行结果 */
  steps: Record<string, PostProcessStepResult>
  /** 所有关键步骤是否通过 */
  allCriticalPassed: boolean
}

/** 解析原有 scope 字符串为 sourceType 和 sourceId */
function parseScope(scope: string): { sourceType: string; sourceId: string } {
  const match = scope.match(/^chapter_(\d+)_finalize$/)
  if (match) return { sourceType: 'chapter_finalize', sourceId: match[1] }
  return { sourceType: 'unknown', sourceId: scope }
}

/** 读取后处理状态 (向后兼容 UI) */
export async function readPostProcessStatus(
  _projectPath: string,
  scope: string,
): Promise<PostProcessStatus | null> {
  try {
    const { sourceType, sourceId } = parseScope(scope)
    const run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)
    if (!run) return null

    const steps = await ipc.invoke('db:post-process-get-steps', run.id)

    const status: PostProcessStatus = {
      scope,
      sourceLabel: run.sourceLabel,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      allCriticalPassed: run.allCriticalPassed,
      steps: {}
    }

    for (const s of steps) {
      status.steps[s.stepKey] = {
        label: s.label,
        critical: s.critical,
        ok: s.ok,
        completedAt: s.completedAt || undefined,
        error: s.errorMsg || undefined,
        lastAttemptAt: s.lastAttemptAt || '',
        attemptCount: s.attemptCount
      }
    }

    return status
  } catch {
    return null
  }
}

/** 快捷检查：所有关键步骤是否通过 */
export async function isAllCriticalPassed(
  _projectPath: string,
  scope: string,
): Promise<boolean> {
  const { sourceType, sourceId } = parseScope(scope)
  return await ipc.invoke('db:post-process-is-all-passed', sourceType, sourceId)
}

/** 提取失败步骤的展示标签列表 */
export function getFailedStepLabels(status: PostProcessStatus): string[] {
  return Object.values(status.steps)
    .filter(s => !s.ok)
    .map(s => s.label)
}

/** 获取章节定稿后处理的 scope 标识 */
export function getChapterFinalizeScope(chapterNumber: number): string {
  return `chapter_${chapterNumber}_finalize`
}

// ===== 流水线执行器 =====

export interface PipelineOptions {
  /** 每步重试次数，默认 2 */
  retryCount?: number
  /** true = 只重跑失败步骤（修复模式） */
  onlyFailed?: boolean
}

/**
 * 执行后处理流水线
 *
 * @param projectPath 项目路径（用于状态文件读写）
 * @param scope 状态文件唯一标识
 * @param sourceLabel 来源描述（展示用）
 * @param steps 步骤列表
 * @param callbacks 工作流回调
 * @param options 可选配置
 * @returns 完整的后处理状态
 */
export async function runPostProcessPipeline(
  projectPath: string,
  scope: string,
  sourceLabel: string,
  steps: PostProcessStep[],
  callbacks: StepCallbacks,
  options?: PipelineOptions,
): Promise<PostProcessStatus> {
  const retryCount = options?.retryCount ?? 2
  const onlyFailed = options?.onlyFailed ?? false

  const { sourceType, sourceId } = parseScope(scope)

  // 判断是否存在已有 instance
  let run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)

  if (!onlyFailed || !run) {
    // 新建跑批
    callbacks.log(`  初始化后处理跑批...`)
    const createRes = await ipc.invoke('db:post-process-create-run', {
      triggerSourceType: sourceType,
      triggerSourceId: sourceId,
      sourceLabel,
      steps: steps.map(s => ({ key: s.key, label: s.label, critical: s.critical }))
    })
    if (!createRes.success || !createRes.id) {
      throw new Error(`创建跑批失败: ${createRes.error}`)
    }
    run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)
  }

  if (!run) throw new Error('跑批获取异常')

  const runId = run.id
  const runSteps = await ipc.invoke('db:post-process-get-steps', runId)
  const stepMap = new Map((runSteps as unknown as Array<Record<string, unknown>>).map((s) => [s.stepKey, s]))

  for (const step of steps) {
    const existingStep = stepMap.get(step.key)

    // 修复模式：跳过已成功的步骤
    if (onlyFailed && existingStep?.ok) {
      callbacks.log(`  ⏭️ ${step.label} — 已成功，跳过`)
      continue
    }

    const result = await withRetry(() => step.executor(callbacks), retryCount, step.label, callbacks)

    if (result.ok) {
      await ipc.invoke('db:post-process-mark-step-ok', runId, step.key)
    } else {
      await ipc.invoke('db:post-process-mark-step-failed', runId, step.key, result.error || '未知错误')
    }
  }

  // 返回最终状态汇总供 UI 展示
  const status = await readPostProcessStatus(projectPath, scope)
  if (!status) {
    throw new Error('汇总状态获取失败')
  }

  // 最终汇总
  const failedSteps = Object.values(status.steps).filter(s => !s.ok)
  const successSteps = Object.values(status.steps).filter(s => s.ok)

  callbacks.log('')
  callbacks.log(`━━━━━━━━━━ ${sourceLabel} 后处理汇总 ━━━━━━━━━━`)
  for (const [, r] of Object.entries(status.steps)) {
    callbacks.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.ok ? '' : ` — ${r.error}`}`)
  }
  callbacks.log(`━━━━━━━━━━ ${successSteps.length}/${Object.keys(status.steps).length} 成功 ━━━━━━━━━━`)

  if (failedSteps.length > 0) {
    const failedLabels = failedSteps.map(r => r.label).join('、')
    callbacks.log(`⚠️ 以下后处理步骤失败：${failedLabels}`)
    if (failedSteps.some(s => s.critical)) {
      callbacks.log('💡 存在关键步骤失败，后续流程可能被阻断。请在对应页面使用「重试」功能修复')
    }
  }

  return status
}

// ===== 章节上下文读取（滚动蓝图刷新用） =====
//
// 这些函数把「已经写出来的事实」聚合成可注入 Prompt 的文本，
// 供写稿前的蓝图自适应刷新使用（generate-draft 内另有同类私有实现，
// 保持其不变以免影响既有写稿链路）。

/** 读取四段式故事架构并拼装为单串文本 */
export async function readArchitectureText(): Promise<string> {
  try {
    const core = await ipc.invoke('db:project-core-get')
    const parts: string[] = []
    if (core?.premise) parts.push(core.premise.trim())
    if (core?.charactersArch) parts.push(core.charactersArch.trim())
    if (core?.worldbuilding) parts.push(core.worldbuilding.trim())
    if (core?.synopsis) parts.push(core.synopsis.trim())
    return parts.join('\n\n---\n\n') || '（暂无故事架构）'
  } catch {
    return '（故事架构读取失败）'
  }
}

/** 读取角色当前状态档案（含已知信息，用于防穿帮） */
export async function readCharacterStatesText(): Promise<string> {
  try {
    const allChars = await ipc.invoke('db:character-get-all')
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
    return states.length > 0 ? states.join('\n') : '（暂无角色状态档案）'
  } catch {
    return '（角色状态档案读取失败）'
  }
}

/**
 * 读取已写章节的要点时间线（来自蓝图 notes，即定稿后回填的实际剧情要点）。
 * 近 fullWindow 章完整收录，更早仅留标题行，总量上限 maxChars。
 *
 * 一次取回全部蓝图再本地过滤：逐章 IPC 会随连载推进线性变慢
 * （写到第 200 章就是 199 次往返，且批量连写每章都要跑一遍）。
 */
export async function readChapterNotesTimeline(
  currentChapter: number,
  fullWindow = 5,
  maxChars = 3000,
): Promise<string> {
  try {
    const all = await ipc.invoke('db:blueprint-get-all')
    const byChapter = new Map((all || []).map(b => [b.chapterNumber, b]))

    const lines: string[] = []
    for (let i = 1; i < currentChapter; i++) {
      const bp = byChapter.get(i)
      if (!bp) continue
      const isRecent = i >= currentChapter - fullWindow
      if (isRecent && bp.notes?.trim()) {
        lines.push(`【第${i}章 ${bp.title || ''}】\n${bp.notes.trim()}`)
      } else {
        lines.push(`【第${i}章 ${bp.title || ''}】`)
      }
    }

    let result = lines.join('\n\n')
    if (result.length > maxChars) result = result.slice(-maxChars)
    return result || '（无章节要点）'
  } catch {
    return '（章节要点读取失败）'
  }
}

/** 读取上一章定稿正文的结尾片段（本章须从此自然接续） */
export async function readPreviousEnding(currentChapter: number, maxChars = 1000): Promise<string> {
  if (currentChapter <= 1) return '（无前文，本章为开篇）'
  try {
    const meta = await ipc.invoke('db:draft-get-finalized', currentChapter - 1)
    if (!meta) return '（上一章尚未定稿）'
    const full = await ipc.invoke('db:draft-get-full', meta.id)
    const content = full?.content?.trim()
    return content ? content.slice(-maxChars) : '（上一章正文为空）'
  } catch {
    return '（上一章正文读取失败）'
  }
}

/** 跨章反雷同：最近数章的开场句与断章句速览 */
export async function buildAntiRepetitionText(currentChapter: number, windowSize = 3): Promise<string> {
  const lines: string[] = []
  for (let i = currentChapter - 1; i >= Math.max(1, currentChapter - windowSize); i--) {
    try {
      const meta = await ipc.invoke('db:draft-get-finalized', i)
      if (!meta) continue
      const full = await ipc.invoke('db:draft-get-full', meta.id)
      const content = full?.content?.trim()
      if (!content) continue
      const opening = content.slice(0, 55).replace(/\s+/g, ' ')
      const closing = content.slice(-45).replace(/\s+/g, ' ')
      lines.push(`- 第${i}章 开场：「${opening}…」｜断章：「…${closing}」`)
    } catch { /* 忽略单章读取失败 */ }
  }
  if (lines.length === 0) return '（暂无往期章节可参考）'
  return lines.reverse().join('\n')
}

/** 未回收伏笔上下文（含到期提醒） */
export async function buildOpenForeshadowingText(currentChapter: number): Promise<string> {
  try {
    const open = await ipc.invoke('db:foreshadow-get-open')
    return formatOpenForeshadowings(open, currentChapter)
  } catch {
    return '（暂无未回收伏笔）'
  }
}

/** 后续若干章蓝图速览（用于约束本章不抢戏、不提前消耗关键节点） */
export async function buildFutureBlueprintsText(currentChapter: number, span = 5): Promise<string> {
  try {
    const all = await ipc.invoke('db:blueprint-get-all')
    const future = (all || []).filter(
      (b) => b.chapterNumber > currentChapter && b.chapterNumber <= currentChapter + span
    )
    if (future.length === 0) return '（无后续蓝图）'
    return future
      .map((b) => `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`)
      .join('\n')
  } catch {
    return '（后续蓝图读取失败）'
  }
}
