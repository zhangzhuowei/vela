/**
 * 参考作品拆书 — Command 集合
 * L0 单章拆解 → L1 阶段轴 / 人物线轴 → L2 总纲 → L3 推进模式 → 作用域微调
 * 全部只读写 ref_* 表，不触碰本书配置 / 架构 / 知识库。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { DIGEST_MAX_CHARS, DIGEST_CONCURRENCY } from '../../reference/cost-estimate'
import type { RefDigestInput, RefCharacterState, RefIntroduced, RefLineData } from '../../../../electron/repositories/reference-repository'
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

/** 两个半章结果合并：摘要拼接、事件拼接、角色状态按名去重取后者 */
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

  constructor(private workId: number, private from: number, private to: number) {
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
    callbacks.log(t('reference.digestStart', { count: pending.length, from: this.from, to: this.to }))
    await ipc.invoke('db:ref-work-upsert', { ...work, status: 'running' })

    let done = 0
    let failed = 0
    const total = pending.length || 1
    const modelId = work.digestModelId || undefined

    const tasks = pending.map((num) => async () => {
      if (context.cancelled) return
      try {
        const ch = await ipc.invoke('db:ref-chapter-get', this.workId, num)
        if (!ch) throw new Error(t('reference.chapterMissing', { chapter: num }))
        const parts = ch.content.length > DIGEST_MAX_CHARS
          ? [ch.content.slice(0, Math.ceil(ch.content.length / 2)), ch.content.slice(Math.ceil(ch.content.length / 2))]
          : [ch.content]
        let merged: DigestJson | null = null
        for (let i = 0; i < parts.length; i++) {
          const partNote = parts.length === 1 ? '' : (i === 0 ? '（前半）' : '（后半）')
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
      if ((done + failed) % 10 === 0) callbacks.log(t('reference.digestProgress', { done, failed, total: pending.length }))
    })

    await runWithConcurrency(tasks, DIGEST_CONCURRENCY, () => context.cancelled)

    const analyzedFrom = work.analyzedFrom > 0 ? Math.min(work.analyzedFrom, this.from) : this.from
    const analyzedTo = Math.max(work.analyzedTo, this.to)
    await ipc.invoke('db:ref-work-upsert', {
      ...work,
      analyzedFrom,
      analyzedTo,
      status: context.cancelled ? 'idle' : (failed > 0 ? 'error' : 'done'),
    })
    callbacks.log(t('reference.digestSummary', { done, failed }))
    this.notifyRefresh(['references'])
  }
}
