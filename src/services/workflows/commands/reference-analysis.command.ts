/**
 * 参考作品拆书 — Command 集合
 * L0 单章拆解 → L1 阶段轴 / 人物线轴 → L2 总纲 → L3 推进模式 → 作用域微调
 * 全部只读写 ref_* 表，不触碰本书配置 / 架构 / 知识库。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { DIGEST_MAX_CHARS, DIGEST_CONCURRENCY, STAGE_BATCH_SIZE } from '../../reference/cost-estimate'
import { splitDigestParts } from '../../reference/digest-chunking'
import { chapterRunQueue, settleDigestWorkProgress } from '../../reference/analyzed-range'
import { batchByCount, mergeStageBatches, pickStageDraft, type StageDraft } from '../../reference/stage-batching'
import { buildLineMatrix, computeLineStats } from '../../reference/line-matrix'
import type { RefDigestInput, RefCharacterState, RefIntroduced, RefLineData, RefWorkData, RefStageData } from '../../../../electron/repositories/reference-repository'
import i18n from '../../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

class RefPromptBuilder extends BasePromptBuilder {
  set(vars: Record<string, string>) {
    Object.assign(this.variables, vars)
    return this
  }
}

function linesToPrompt(lines: RefLineData[]): string {
  if (lines.length === 0) return '（暂无）'
  return lines.map((l) => `- ${l.name}${l.aliases.length ? `（别名：${l.aliases.join('、')}）` : ''}`).join('\n')
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number, isCancelled: () => boolean) {
  const executing = new Set<Promise<void>>()
  for (const task of tasks) {
    if (isCancelled()) break
    const p = task().then(() => { executing.delete(p) })
    executing.add(p)
    if (executing.size >= limit) await Promise.race(executing)
  }
  await Promise.all(executing)
}

interface DigestJson {
  summary?: string
  events?: string[]
  hook?: string
  activeLine?: string
  characterStates?: RefCharacterState[]
  introduced?: RefIntroduced[]
  intimate?: boolean
}

/** 多段结果合并：摘要拼接、事件拼接、角色状态按名去重取后者 */
export function mergeDigestHalves(a: DigestJson, b: DigestJson): DigestJson {
  const states = new Map<string, RefCharacterState>()
  for (const s of [...(a.characterStates ?? []), ...(b.characterStates ?? [])]) states.set(s.name, s)
  return {
    summary: [a.summary, b.summary].filter(Boolean).join(' '),
    events: [...(a.events ?? []), ...(b.events ?? [])],
    hook: b.hook || a.hook || '',
    activeLine: b.activeLine || a.activeLine || '',
    characterStates: [...states.values()],
    introduced: [...(a.introduced ?? []), ...(b.introduced ?? [])],
    intimate: Boolean(a.intimate || b.intimate),
  }
}

// =================================================================
// L0：逐章拆解（断点续跑 + 并发 + 分模型 + 挂 mod）
// =================================================================
export class RefDigestChaptersCommand extends BaseWorkflowCommand<void> {
  protected attachModGuidance = true
  protected get callPurpose() { return 'RefDigest' }

  constructor(private workId: number, private from: number, private to: number, private forceChapters?: number[]) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const work = await ipc.invoke('db:ref-work-get', this.workId)
    if (!work) throw new Error(t('reference.workNotFound'))
    const template = getPromptTemplate('ref_chapter_digest')
    if (!template) throw new Error(t('reference.templateNotFound', { key: 'ref_chapter_digest' }))

    const lines = await ipc.invoke('db:ref-line-list', this.workId)
    const knownLines = linesToPrompt(lines)
    const pending = await ipc.invoke('db:ref-chapter-pending', this.workId, this.from, this.to)
    const queue = chapterRunQueue(pending, this.forceChapters)
    callbacks.log(t('reference.digestStart', { count: queue.length, from: this.from, to: this.to }))
    await ipc.invoke('db:ref-work-upsert', { ...work, status: 'running' })

    let done = 0
    let failed = 0
    const total = queue.length || 1
    const modelId = work.digestModelId || undefined

    const tasks = queue.map((num) => async () => {
      if (context.cancelled) return
      try {
        const ch = await ipc.invoke('db:ref-chapter-get', this.workId, num)
        if (!ch) throw new Error(t('reference.chapterMissing', { chapter: num }))
        const parts = splitDigestParts(ch.content, DIGEST_MAX_CHARS)
        let merged: DigestJson | null = null
        for (let i = 0; i < parts.length; i++) {
          const partNote = parts.length === 1 ? '' : `（第 ${i + 1}/${parts.length} 段）`
          const builder = new RefPromptBuilder(template).set({
            chapter_number: String(num),
            chapter_title: ch.title,
            chapter_content: parts[i],
            part_note: partNote,
            known_lines: knownLines,
          })
          const raw = await this.callLLMWithBuilder(builder, callbacks, { responseFormat: { type: 'json_object' } }, context, modelId)
          const json = this.parseJSON<DigestJson>(raw)
          merged = merged ? mergeDigestHalves(merged, json) : json
        }
        const digest: RefDigestInput = {
          workId: this.workId,
          chapterNumber: num,
          summary: merged?.summary ?? '',
          events: merged?.events ?? [],
          hook: merged?.hook ?? '',
          activeLine: merged?.activeLine ?? '',
          characterStates: merged?.characterStates ?? [],
          introduced: merged?.introduced ?? [],
          intimate: Boolean(merged?.intimate),
          status: 'ok',
          error: '',
        }
        const res = await ipc.invoke('db:ref-digest-upsert', digest)
        if (!res.success) throw new Error(res.error)
        done++
      } catch (err) {
        if (context.cancelled) return
        failed++
        const message = err instanceof Error ? err.message : String(err)
        await ipc.invoke('db:ref-digest-upsert', {
          workId: this.workId, chapterNumber: num, summary: '', events: [], hook: '', activeLine: '',
          characterStates: [], introduced: [], intimate: false, status: 'failed', error: message.slice(0, 2000),
        })
        callbacks.log(t('reference.digestFailed', { chapter: num, error: message }))
      }
      callbacks.setProgress(Math.round(((done + failed) / total) * 100))
      if ((done + failed) % 10 === 0) callbacks.log(t('reference.digestProgress', { done, failed, total: queue.length }))
    })

    await runWithConcurrency(tasks, DIGEST_CONCURRENCY, () => context.cancelled)

    const allDigests = await ipc.invoke('db:ref-digest-list', this.workId)
    const okNums = allDigests.filter((d) => d.status === 'ok').map((d) => d.chapterNumber)
    const anyFailed = allDigests.some((d) => d.status === 'failed')
    const leftover = await ipc.invoke('db:ref-chapter-pending', this.workId, 1, work.totalChapters)
    const settled = settleDigestWorkProgress(okNums, anyFailed, leftover.length)
    await ipc.invoke('db:ref-work-upsert', {
      ...work,
      analyzedFrom: settled.analyzedFrom,
      analyzedTo: settled.analyzedTo,
      status: context.cancelled ? 'idle' : settled.status,
    })
    callbacks.log(t('reference.digestSummary', { done, failed }))
    this.notifyRefresh(['references'])
  }
}

async function loadWorkBundle(workId: number) {
  const [work, digests, lines, stages] = await Promise.all([
    ipc.invoke('db:ref-work-get', workId),
    ipc.invoke('db:ref-digest-list', workId),
    ipc.invoke('db:ref-line-list', workId),
    ipc.invoke('db:ref-stage-list', workId),
  ])
  if (!work) throw new Error(t('reference.workNotFound'))
  return { work, digests: digests.filter((d) => d.status === 'ok'), lines, stages }
}

function sampleNote(work: RefWorkData): string {
  return work.analyzedTo < work.totalChapters
    ? `（注意：以下仅基于第 ${work.analyzedFrom}～${work.analyzedTo} 章的抽样，全书共 ${work.totalChapters} 章。）`
    : ''
}

function stagesToPrompt(stages: Array<Pick<RefStageData, 'seq' | 'title' | 'fromChapter' | 'toChapter' | 'goal' | 'antagonist' | 'exitPeak'>>): string {
  return stages.map((s) => `${s.seq}｜${s.title}｜第${s.fromChapter}～${s.toChapter}章｜${s.goal}｜敌:${s.antagonist}｜爆点:${s.exitPeak}`).join('\n')
}

export class RefSegmentStagesCommand extends BaseWorkflowCommand<void> {
  protected attachModGuidance = true
  protected get callPurpose() { return 'RefStages' }
  constructor(private workId: number, private userHint = '') { super() }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const { work, digests, lines } = await loadWorkBundle(this.workId)
    const template = getPromptTemplate('ref_stage_segment')
    if (!template) throw new Error(t('reference.templateNotFound', { key: 'ref_stage_segment' }))

    const batches = batchByCount(digests, STAGE_BATCH_SIZE)
    const results: StageDraft[][] = []
    for (let i = 0; i < batches.length; i++) {
      if (context.cancelled) throw new Error(t('base.workflowCancelled'))
      const batch = batches[i]
      const prevTail = results.length ? results[results.length - 1].slice(-1)[0] : null
      const digestsText = batch.map((d) => {
        const active = d.activeLine
          ? (lines.find((l) => l.name === d.activeLine || l.aliases.includes(d.activeLine))?.name ?? d.activeLine)
          : '—'
        return `第${d.chapterNumber}章｜${active}｜${d.summary}`
      }).join('\n')
      const builder = new RefPromptBuilder(template).set({
        digests: digestsText,
        previous_tail: prevTail ? `${prevTail.title}（第${prevTail.fromChapter}～${prevTail.toChapter}章）：${prevTail.goal}` : '（无）',
        user_hint: this.userHint,
      })
      const raw = await this.callLLMWithBuilder(builder, callbacks, { responseFormat: { type: 'json_object' } }, context, work.outlineModelId || undefined)
      const json = this.parseJSON<{ stages: StageDraft[] }>(raw)
      results.push(json.stages ?? [])
      callbacks.log(t('reference.stageBatchDone', { index: i + 1, total: batches.length, count: json.stages?.length ?? 0 }))
      callbacks.setProgress(Math.round(((i + 1) / Math.max(1, batches.length)) * 100))
    }
    const merged = mergeStageBatches(results)
    const res = await ipc.invoke('db:ref-stage-replace-unlocked', this.workId, merged.map(({ continuesPrevious: _c, ...s }) => ({ ...s, locked: false })))
    if (!res.success) throw new Error(res.error)
    callbacks.log(t('reference.stagesSaved', { count: merged.length }))
    this.notifyRefresh(['references'])
  }
}

export class RefRerunStageCommand extends BaseWorkflowCommand<void> {
  protected attachModGuidance = true
  protected get callPurpose() { return 'RefStages' }
  constructor(private workId: number, private stageId: number) { super() }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const { work, digests, lines, stages } = await loadWorkBundle(this.workId)
    const cur = stages.find((s) => s.id === this.stageId)
    if (!cur) throw new Error(t('reference.nothingToRefine'))
    if (cur.locked) throw new Error(t('reference.targetLocked'))
    const template = getPromptTemplate('ref_stage_segment')
    if (!template) throw new Error(t('reference.templateNotFound', { key: 'ref_stage_segment' }))
    const inRange = digests.filter((d) => d.chapterNumber >= cur.fromChapter && d.chapterNumber <= cur.toChapter)
    const prev = stages.find((s) => s.seq === cur.seq - 1)
    const digestsText = inRange.map((d) => {
      const active = d.activeLine
        ? (lines.find((l) => l.name === d.activeLine || l.aliases.includes(d.activeLine))?.name ?? d.activeLine)
        : '—'
      return `第${d.chapterNumber}章｜${active}｜${d.summary}`
    }).join('\n')
    const builder = new RefPromptBuilder(template).set({
      digests: digestsText || '（无）',
      previous_tail: prev ? `${prev.title}（第${prev.fromChapter}～${prev.toChapter}章）：${prev.goal}` : '（无）',
      user_hint: `只重写当前这一段，起止章必须保持第 ${cur.fromChapter}～${cur.toChapter} 章，不要改边界。`,
    })
    const raw = await this.callLLMWithBuilder(builder, callbacks, { responseFormat: { type: 'json_object' } }, context, work.outlineModelId || undefined)
    const json = this.parseJSON<{ stages: StageDraft[] }>(raw)
    const draft = pickStageDraft(json.stages ?? [], cur.fromChapter, cur.toChapter)
    if (!draft) throw new Error(t('reference.nothingToRefine'))
    await ipc.invoke('db:ref-stage-upsert', {
      ...cur,
      title: draft.title || cur.title,
      goal: draft.goal || cur.goal,
      antagonist: draft.antagonist || cur.antagonist,
      entryHook: draft.entryHook || cur.entryHook,
      exitPeak: draft.exitPeak || cur.exitPeak,
    })
    callbacks.log(t('reference.stagesSaved', { count: 1 }))
    this.notifyRefresh(['references'])
  }
}

export class RefLineArcsCommand extends BaseWorkflowCommand<void> {
  protected attachModGuidance = true
  protected get callPurpose() { return 'RefLineArc' }
  constructor(private workId: number, private onlyLineId?: number, private userHint = '') { super() }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const { work, digests, lines } = await loadWorkBundle(this.workId)
    const template = getPromptTemplate('ref_line_arc')
    if (!template) throw new Error(t('reference.templateNotFound', { key: 'ref_line_arc' }))
    const matrix = buildLineMatrix(digests, lines)
    const stats = computeLineStats(matrix)
    const targets = lines.filter((l) => (this.onlyLineId ? l.id === this.onlyLineId : !l.locked))
    if (this.onlyLineId) {
      const line = lines.find((l) => l.id === this.onlyLineId)
      if (line?.locked) throw new Error(t('reference.targetLocked'))
    }
    const byCh = new Map(digests.map((d) => [d.chapterNumber, d]))

    for (let i = 0; i < targets.length; i++) {
      if (context.cancelled) throw new Error(t('base.workflowCancelled'))
      const line = targets[i]
      const st = stats.perLine.find((s) => s.lineId === line.id)
      const row = matrix.rows.find((r) => r.lineId === line.id)
      if (!st || !row) continue
      const lineChapters = row.cells.map((c, idx) => {
        if (!c) return null
        const ch = matrix.chapters[idx]
        return `第${ch}章｜${c.stage}｜${c.func}｜${(byCh.get(ch)?.summary ?? '').slice(0, 60)}`
      }).filter(Boolean).join('\n')
      const builder = new RefPromptBuilder(template).set({
        line_name: line.name,
        line_stats: `首出场 第${st.firstChapter ?? '-'}章｜主攻 ${st.mainCount} 章（最后主攻 第${st.lastMainChapter ?? '-'}章）｜日常 ${st.dailyCount}｜助攻 ${st.assistCount}｜引出 ${st.introduceCount}｜亲密场面 ${st.intimateCount}｜最长缺席 ${st.maxGap} 章`,
        line_chapters: lineChapters || '（无）',
        user_hint: this.userHint,
      })
      const arc = await this.callLLMWithBuilder(builder, callbacks, undefined, context, work.outlineModelId || undefined)
      await ipc.invoke('db:ref-line-upsert', { ...line, arcSummary: arc.trim() })
      callbacks.log(t('reference.lineArcDone', { name: line.name }))
      callbacks.setProgress(Math.round(((i + 1) / Math.max(1, targets.length)) * 100))
    }
    this.notifyRefresh(['references'])
  }
}

export class RefGlobalOutlineCommand extends BaseWorkflowCommand<void> {
  protected attachModGuidance = true
  protected get callPurpose() { return 'RefOutlineL2' }
  constructor(private workId: number, private userHint = '') { super() }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const { work, lines, stages } = await loadWorkBundle(this.workId)
    const cur = await ipc.invoke('db:ref-outline-get', this.workId, 'L2')
    if (cur?.locked) { callbacks.log(t('reference.outlineLockedSkip', { level: 'L2' })); return }
    const template = getPromptTemplate('ref_global_outline')
    if (!template) throw new Error(t('reference.templateNotFound', { key: 'ref_global_outline' }))
    const builder = new RefPromptBuilder(template).set({
      work_name: work.name,
      stages: stagesToPrompt(stages) || '（尚未切阶段）',
      line_arcs: lines.filter((l) => l.arcSummary).map((l) => `### ${l.name}\n${l.arcSummary}`).join('\n\n') || '（尚无人物线弧）',
      sample_note: sampleNote(work),
      user_hint: this.userHint,
    })
    const body = await this.callLLMWithBuilder(builder, callbacks, undefined, context, work.outlineModelId || undefined)
    await ipc.invoke('db:ref-outline-upsert', { workId: this.workId, level: 'L2', body: body.trim() })
    callbacks.log(t('reference.outlineSaved', { level: 'L2' }))
    this.notifyRefresh(['references'])
  }
}

export class RefProgressionPatternCommand extends BaseWorkflowCommand<void> {
  protected attachModGuidance = true
  protected get callPurpose() { return 'RefOutlineL3' }
  constructor(private workId: number, private userHint = '') { super() }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const { work, digests, lines, stages } = await loadWorkBundle(this.workId)
    const cur = await ipc.invoke('db:ref-outline-get', this.workId, 'L3')
    if (cur?.locked) { callbacks.log(t('reference.outlineLockedSkip', { level: 'L3' })); return }
    const template = getPromptTemplate('ref_progression_pattern')
    if (!template) throw new Error(t('reference.templateNotFound', { key: 'ref_progression_pattern' }))
    const stats = computeLineStats(buildLineMatrix(digests, lines))
    const nameOf = (id: number) => lines.find((l) => l.id === id)?.name ?? String(id)
    const statsText = ['线｜首出场｜主攻章数｜日常｜助攻｜引出｜亲密｜最长缺席',
      ...stats.perLine.map((s) => `${nameOf(s.lineId)}｜${s.firstChapter ?? '-'}｜${s.mainCount}｜${s.dailyCount}｜${s.assistCount}｜${s.introduceCount}｜${s.intimateCount}｜${s.maxGap}`),
      `主攻线平均连续章数：${stats.avgMainRun}`].join('\n')
    const switches = stats.switchPoints.map((p) => `第${p.chapter}章：${nameOf(p.fromLineId)} → ${nameOf(p.toLineId)}`).join('\n') || '（无）'
    const step = Math.max(1, Math.floor(digests.length / 30) || 1)
    const hooks = digests.filter((_, i) => i % step === 0).slice(0, 30).map((d) => `第${d.chapterNumber}章：${d.hook || '（无钩子）'}`).join('\n')
    const builder = new RefPromptBuilder(template).set({
      stages: stagesToPrompt(stages) || '（尚未切阶段）',
      line_stats: statsText,
      switch_points: switches,
      hooks_sample: hooks,
      sample_note: sampleNote(work),
      user_hint: this.userHint,
    })
    const body = await this.callLLMWithBuilder(builder, callbacks, undefined, context, work.outlineModelId || undefined)
    await ipc.invoke('db:ref-outline-upsert', { workId: this.workId, level: 'L3', body: body.trim() })
    callbacks.log(t('reference.outlineSaved', { level: 'L3' }))
    this.notifyRefresh(['references'])
  }
}

export type RefRefineScope =
  | { kind: 'L2' } | { kind: 'L3' }
  | { kind: 'stage'; stageId: number }
  | { kind: 'line'; lineId: number }
  | { kind: 'digest'; chapterNumber: number }

export type RefRerunScope = RefRefineScope | { kind: 'lines' }

export class RefRefineCommand extends BaseWorkflowCommand<void> {
  protected attachModGuidance = true
  protected get callPurpose() { return 'RefRefine' }
  constructor(private workId: number, private scope: RefRefineScope, private instruction: string) { super() }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const { work, digests, lines, stages } = await loadWorkBundle(this.workId)
    const template = getPromptTemplate('ref_refine')
    if (!template) throw new Error(t('reference.templateNotFound', { key: 'ref_refine' }))
    const modelId = work.outlineModelId || undefined
    const s = this.scope

    if (s.kind === 'L2' || s.kind === 'L3') {
      const cur = await ipc.invoke('db:ref-outline-get', this.workId, s.kind)
      if (!cur) throw new Error(t('reference.nothingToRefine'))
      if (cur.locked) throw new Error(t('reference.targetLocked'))
      const builder = new RefPromptBuilder(template).set({
        scope_label: s.kind === 'L2' ? 'L2 全书总纲' : 'L3 推进模式',
        current: cur.body, instruction: this.instruction, output_format: '输出完整 Markdown，结构与当前内容一致。',
      })
      const after = (await this.callLLMWithBuilder(builder, callbacks, undefined, context, modelId)).trim()
      await ipc.invoke('db:ref-revision-insert', { workId: this.workId, scope: s.kind, targetId: 0, instruction: this.instruction, before: cur.body, after })
      await ipc.invoke('db:ref-outline-upsert', { workId: this.workId, level: s.kind, body: after })
      this.notifyRefresh(['references'])
      return
    }

    if (s.kind === 'stage') {
      const cur = stages.find((x) => x.id === s.stageId)
      if (!cur) throw new Error(t('reference.nothingToRefine'))
      if (cur.locked) throw new Error(t('reference.targetLocked'))
      const inRange = digests.filter((d) => d.chapterNumber >= cur.fromChapter && d.chapterNumber <= cur.toChapter)
      const builder = new RefPromptBuilder(template).set({
        scope_label: `第 ${cur.seq} 阶段「${cur.title}」（第 ${cur.fromChapter}～${cur.toChapter} 章）`,
        current: JSON.stringify({ title: cur.title, fromChapter: cur.fromChapter, toChapter: cur.toChapter, goal: cur.goal, antagonist: cur.antagonist, entryHook: cur.entryHook, exitPeak: cur.exitPeak }, null, 2)
          + `\n\n【本阶段章摘要】\n${inRange.map((d) => `第${d.chapterNumber}章｜${d.summary}`).join('\n')}`,
        instruction: this.instruction,
        output_format: '输出与当前 JSON 同结构的 JSON（title/fromChapter/toChapter/goal/antagonist/entryHook/exitPeak），仅输出 JSON。',
      })
      const raw = await this.callLLMWithBuilder(builder, callbacks, { responseFormat: { type: 'json_object' } }, context, modelId)
      const json = this.parseJSON<Partial<typeof cur>>(raw)
      const next = { ...cur, ...json, id: cur.id, workId: cur.workId, seq: cur.seq, locked: cur.locked }
      await ipc.invoke('db:ref-revision-insert', { workId: this.workId, scope: 'stage', targetId: cur.id, instruction: this.instruction, before: JSON.stringify(cur), after: JSON.stringify(next) })
      await ipc.invoke('db:ref-stage-upsert', next)
      this.notifyRefresh(['references'])
      return
    }

    if (s.kind === 'line') {
      const cur = lines.find((x) => x.id === s.lineId)
      if (!cur) throw new Error(t('reference.nothingToRefine'))
      if (cur.locked) throw new Error(t('reference.targetLocked'))
      const before = cur.arcSummary
      await new RefLineArcsCommand(this.workId, cur.id, `【用户建议】${this.instruction}`).execute({ step: undefined, context, callbacks })
      const refreshed = (await ipc.invoke('db:ref-line-list', this.workId)).find((x) => x.id === cur.id)
      await ipc.invoke('db:ref-revision-insert', { workId: this.workId, scope: 'line', targetId: cur.id, instruction: this.instruction, before, after: refreshed?.arcSummary ?? '' })
      this.notifyRefresh(['references'])
      return
    }

    const chapterDigest = digests.find((d) => d.chapterNumber === s.chapterNumber)
    const ch = await ipc.invoke('db:ref-chapter-get', this.workId, s.chapterNumber)
    if (!ch) throw new Error(t('reference.chapterMissing', { chapter: s.chapterNumber }))
    const digestTemplate = getPromptTemplate('ref_chapter_digest')
    if (!digestTemplate) throw new Error(t('reference.templateNotFound', { key: 'ref_chapter_digest' }))
    const builder = new RefPromptBuilder(digestTemplate).set({
      chapter_number: String(ch.number), chapter_title: ch.title, chapter_content: ch.content.slice(0, DIGEST_MAX_CHARS),
      part_note: '', known_lines: `${linesToPrompt(lines)}\n\n【用户对本章摘要的要求】${this.instruction}`,
    })
    const raw = await this.callLLMWithBuilder(builder, callbacks, { responseFormat: { type: 'json_object' } }, context, work.digestModelId || undefined)
    const json = this.parseJSON<DigestJson>(raw)
    const next: RefDigestInput = {
      workId: this.workId, chapterNumber: ch.number, summary: json.summary ?? '', events: json.events ?? [], hook: json.hook ?? '',
      activeLine: json.activeLine ?? '', characterStates: json.characterStates ?? [], introduced: json.introduced ?? [],
      intimate: Boolean(json.intimate), status: 'ok', error: '',
    }
    await ipc.invoke('db:ref-revision-insert', { workId: this.workId, scope: 'digest', targetId: ch.number, instruction: this.instruction, before: JSON.stringify(chapterDigest ?? {}), after: JSON.stringify(next) })
    await ipc.invoke('db:ref-digest-upsert', next)
    this.notifyRefresh(['references'])
  }
}
