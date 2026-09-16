/**
 * ReferenceRepository — 参考作品拆书（ref_* 七表）
 * 范文正文与分层大纲都留在这里，不进写作知识库。
 */
import { getProjectDb } from '../database'

export type RefWorkStatus = 'idle' | 'running' | 'done' | 'error'
export type RefLineKind = 'romance' | 'plot' | 'other'
export type RefStage = 'first_meet' | 'progress' | 'breakthrough' | 'closure' | 'done' | 'none'
export type RefFunc = 'main' | 'daily' | 'assist' | 'introduce' | 'mention'
export type RefOutlineLevel = 'L2' | 'L3'
export type RefRevisionScope = 'L2' | 'L3' | 'stage' | 'line' | 'digest'

export interface RefWorkData {
  id: number
  name: string
  sourceFiles: string[]
  totalChapters: number
  totalWords: number
  analyzedFrom: number
  analyzedTo: number
  digestModelId: string
  outlineModelId: string
  status: RefWorkStatus
  createdAt: string
  updatedAt: string
}
export type RefWorkInput = Omit<RefWorkData, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }

export interface RefChapterMeta { workId: number; number: number; title: string; wordCount: number }
export interface RefChapterData extends RefChapterMeta { content: string }

export interface RefCharacterState { name: string; stage: RefStage; func: RefFunc }
export interface RefIntroduced { name: string; by: string }

export interface RefDigestData {
  workId: number
  chapterNumber: number
  summary: string
  events: string[]
  hook: string
  activeLine: string
  characterStates: RefCharacterState[]
  introduced: RefIntroduced[]
  intimate: boolean
  status: 'ok' | 'failed'
  error: string
  updatedAt: string
}
export type RefDigestInput = Omit<RefDigestData, 'updatedAt'>

export interface RefLineData {
  id: number
  workId: number
  name: string
  aliases: string[]
  kind: RefLineKind
  sortOrder: number
  locked: boolean
  arcSummary: string
}
export type RefLineInput = Omit<RefLineData, 'id'> & { id?: number }

export interface RefStageData {
  id: number
  workId: number
  seq: number
  title: string
  fromChapter: number
  toChapter: number
  goal: string
  antagonist: string
  entryHook: string
  exitPeak: string
  locked: boolean
}
export type RefStageInput = Omit<RefStageData, 'id'> & { id?: number }

export interface RefOutlineData {
  workId: number
  level: RefOutlineLevel
  body: string
  version: number
  locked: boolean
  updatedAt: string
}

export interface RefRevisionData {
  id: number
  workId: number
  scope: RefRevisionScope
  targetId: number
  instruction: string
  before: string
  after: string
  createdAt: string
}
export type RefRevisionInput = Omit<RefRevisionData, 'id' | 'createdAt'>

function parseJsonArray<T>(raw: unknown, fallback: T[] = []): T[] {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : fallback
  } catch {
    return fallback
  }
}

function db() {
  const d = getProjectDb()
  if (!d) throw new Error('[ReferenceRepository] 数据库未连接')
  return d
}

function rowToWork(r: Record<string, unknown>): RefWorkData {
  const status = String(r.status ?? 'idle') as RefWorkStatus
  return {
    id: r.id as number,
    name: String(r.name ?? ''),
    sourceFiles: parseJsonArray<string>(r.source_files),
    totalChapters: Number(r.total_chapters ?? 0),
    totalWords: Number(r.total_words ?? 0),
    analyzedFrom: Number(r.analyzed_from ?? 0),
    analyzedTo: Number(r.analyzed_to ?? 0),
    digestModelId: String(r.digest_model_id ?? ''),
    outlineModelId: String(r.outline_model_id ?? ''),
    status: (['idle', 'running', 'done', 'error'] as RefWorkStatus[]).includes(status) ? status : 'idle',
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }
}

function rowToDigest(r: Record<string, unknown>): RefDigestData {
  return {
    workId: Number(r.work_id),
    chapterNumber: Number(r.chapter_number),
    summary: String(r.summary ?? ''),
    events: parseJsonArray<string>(r.events),
    hook: String(r.hook ?? ''),
    activeLine: String(r.active_line ?? ''),
    characterStates: parseJsonArray<RefCharacterState>(r.character_states),
    introduced: parseJsonArray<RefIntroduced>(r.introduced),
    intimate: Number(r.intimate ?? 0) === 1,
    status: r.status === 'failed' ? 'failed' : 'ok',
    error: String(r.error ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }
}

function rowToLine(r: Record<string, unknown>): RefLineData {
  const kind = String(r.kind ?? 'romance') as RefLineKind
  return {
    id: r.id as number,
    workId: Number(r.work_id),
    name: String(r.name ?? ''),
    aliases: parseJsonArray<string>(r.aliases),
    kind: (['romance', 'plot', 'other'] as RefLineKind[]).includes(kind) ? kind : 'other',
    sortOrder: Number(r.sort_order ?? 0),
    locked: Number(r.locked ?? 0) === 1,
    arcSummary: String(r.arc_summary ?? ''),
  }
}

function rowToStage(r: Record<string, unknown>): RefStageData {
  return {
    id: r.id as number,
    workId: Number(r.work_id),
    seq: Number(r.seq ?? 0),
    title: String(r.title ?? ''),
    fromChapter: Number(r.from_chapter ?? 0),
    toChapter: Number(r.to_chapter ?? 0),
    goal: String(r.goal ?? ''),
    antagonist: String(r.antagonist ?? ''),
    entryHook: String(r.entry_hook ?? ''),
    exitPeak: String(r.exit_peak ?? ''),
    locked: Number(r.locked ?? 0) === 1,
  }
}

function rowToOutline(r: Record<string, unknown>): RefOutlineData {
  return {
    workId: Number(r.work_id),
    level: r.level === 'L3' ? 'L3' : 'L2',
    body: String(r.body ?? ''),
    version: Number(r.version ?? 1),
    locked: Number(r.locked ?? 0) === 1,
    updatedAt: String(r.updated_at ?? ''),
  }
}

function rowToRevision(r: Record<string, unknown>): RefRevisionData {
  return {
    id: r.id as number,
    workId: Number(r.work_id),
    scope: String(r.scope) as RefRevisionScope,
    targetId: Number(r.target_id ?? 0),
    instruction: String(r.instruction ?? ''),
    before: String(r.before ?? ''),
    after: String(r.after ?? ''),
    createdAt: String(r.created_at ?? ''),
  }
}

export class ReferenceRepository {
  static listWorks(): RefWorkData[] {
    const rows = db().prepare('SELECT * FROM ref_works ORDER BY updated_at DESC, id DESC').all() as Record<string, unknown>[]
    return rows.map(rowToWork)
  }

  static getWork(id: number): RefWorkData | null {
    const row = db().prepare('SELECT * FROM ref_works WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToWork(row) : null
  }

  static upsertWork(data: RefWorkInput): number {
    const d = db()
    if (data.id && data.id > 0) {
      d.prepare(`
        UPDATE ref_works SET name = ?, source_files = ?, total_chapters = ?, total_words = ?,
          analyzed_from = ?, analyzed_to = ?, digest_model_id = ?, outline_model_id = ?, status = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(data.name, JSON.stringify(data.sourceFiles), data.totalChapters, data.totalWords,
        data.analyzedFrom, data.analyzedTo, data.digestModelId, data.outlineModelId, data.status, data.id)
      return data.id
    }
    const res = d.prepare(`
      INSERT INTO ref_works (name, source_files, total_chapters, total_words, analyzed_from, analyzed_to,
        digest_model_id, outline_model_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(data.name, JSON.stringify(data.sourceFiles), data.totalChapters, data.totalWords,
      data.analyzedFrom, data.analyzedTo, data.digestModelId, data.outlineModelId, data.status)
    return Number(res.lastInsertRowid)
  }

  static deleteWork(id: number): void {
    db().prepare('DELETE FROM ref_works WHERE id = ?').run(id)
  }

  static replaceChapters(workId: number, chapters: Array<Omit<RefChapterData, 'workId'>>): void {
    const d = db()
    const del = d.prepare('DELETE FROM ref_chapters WHERE work_id = ?')
    const ins = d.prepare('INSERT INTO ref_chapters (work_id, number, title, content, word_count) VALUES (?, ?, ?, ?, ?)')
    const upd = d.prepare('UPDATE ref_works SET total_chapters = ?, total_words = ?, updated_at = datetime(\'now\') WHERE id = ?')
    d.transaction(() => {
      del.run(workId)
      let words = 0
      for (const c of chapters) {
        ins.run(workId, c.number, c.title, c.content, c.wordCount)
        words += c.wordCount
      }
      upd.run(chapters.length, words, workId)
    })()
  }

  static listChapterMeta(workId: number): RefChapterMeta[] {
    const rows = db().prepare(
      'SELECT work_id, number, title, word_count FROM ref_chapters WHERE work_id = ? ORDER BY number',
    ).all(workId) as Record<string, unknown>[]
    return rows.map((r) => ({
      workId: Number(r.work_id), number: Number(r.number), title: String(r.title ?? ''), wordCount: Number(r.word_count ?? 0),
    }))
  }

  static getChapter(workId: number, number: number): RefChapterData | null {
    const r = db().prepare('SELECT * FROM ref_chapters WHERE work_id = ? AND number = ?').get(workId, number) as Record<string, unknown> | undefined
    if (!r) return null
    return {
      workId, number, title: String(r.title ?? ''), content: String(r.content ?? ''), wordCount: Number(r.word_count ?? 0),
    }
  }

  static upsertDigest(data: RefDigestInput): void {
    db().prepare(`
      INSERT INTO ref_digests (work_id, chapter_number, summary, events, hook, active_line, character_states,
        introduced, intimate, status, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(work_id, chapter_number) DO UPDATE SET
        summary = excluded.summary, events = excluded.events, hook = excluded.hook,
        active_line = excluded.active_line, character_states = excluded.character_states,
        introduced = excluded.introduced, intimate = excluded.intimate,
        status = excluded.status, error = excluded.error, updated_at = datetime('now')
    `).run(data.workId, data.chapterNumber, data.summary, JSON.stringify(data.events), data.hook,
      data.activeLine, JSON.stringify(data.characterStates), JSON.stringify(data.introduced),
      data.intimate ? 1 : 0, data.status, data.error)
  }

  static listDigests(workId: number): RefDigestData[] {
    const rows = db().prepare('SELECT * FROM ref_digests WHERE work_id = ? ORDER BY chapter_number').all(workId) as Record<string, unknown>[]
    return rows.map(rowToDigest)
  }

  /** 还没有成功 L0 的章号（用于断点续跑） */
  static listPendingChapterNumbers(workId: number, from: number, to: number): number[] {
    const rows = db().prepare(`
      SELECT c.number FROM ref_chapters c
      LEFT JOIN ref_digests d ON d.work_id = c.work_id AND d.chapter_number = c.number AND d.status = 'ok'
      WHERE c.work_id = ? AND c.number BETWEEN ? AND ? AND d.chapter_number IS NULL
      ORDER BY c.number
    `).all(workId, from, to) as Array<{ number: number }>
    return rows.map((r) => r.number)
  }

  static listLines(workId: number): RefLineData[] {
    const rows = db().prepare('SELECT * FROM ref_lines WHERE work_id = ? ORDER BY sort_order, id').all(workId) as Record<string, unknown>[]
    return rows.map(rowToLine)
  }

  static upsertLine(data: RefLineInput): number {
    const d = db()
    if (data.id && data.id > 0) {
      d.prepare(`UPDATE ref_lines SET name = ?, aliases = ?, kind = ?, sort_order = ?, locked = ?, arc_summary = ? WHERE id = ?`)
        .run(data.name, JSON.stringify(data.aliases), data.kind, data.sortOrder, data.locked ? 1 : 0, data.arcSummary, data.id)
      return data.id
    }
    const res = d.prepare(`INSERT INTO ref_lines (work_id, name, aliases, kind, sort_order, locked, arc_summary) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data.workId, data.name, JSON.stringify(data.aliases), data.kind, data.sortOrder, data.locked ? 1 : 0, data.arcSummary)
    return Number(res.lastInsertRowid)
  }

  static deleteLine(id: number): void {
    db().prepare('DELETE FROM ref_lines WHERE id = ?').run(id)
  }

  static listStages(workId: number): RefStageData[] {
    const rows = db().prepare('SELECT * FROM ref_stages WHERE work_id = ? ORDER BY seq, id').all(workId) as Record<string, unknown>[]
    return rows.map(rowToStage)
  }

  /** 整体替换未锁定阶段：锁定的保留，其余删掉再按 seq 插入 */
  static replaceUnlockedStages(workId: number, stages: Array<Omit<RefStageInput, 'id' | 'workId'>>): void {
    const d = db()
    d.transaction(() => {
      d.prepare('DELETE FROM ref_stages WHERE work_id = ? AND locked = 0').run(workId)
      const ins = d.prepare(`INSERT INTO ref_stages (work_id, seq, title, from_chapter, to_chapter, goal, antagonist, entry_hook, exit_peak, locked)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      for (const s of stages) ins.run(workId, s.seq, s.title, s.fromChapter, s.toChapter, s.goal, s.antagonist, s.entryHook, s.exitPeak)
    })()
  }

  static upsertStage(data: RefStageInput): number {
    const d = db()
    if (data.id && data.id > 0) {
      d.prepare(`UPDATE ref_stages SET seq = ?, title = ?, from_chapter = ?, to_chapter = ?, goal = ?, antagonist = ?, entry_hook = ?, exit_peak = ?, locked = ? WHERE id = ?`)
        .run(data.seq, data.title, data.fromChapter, data.toChapter, data.goal, data.antagonist, data.entryHook, data.exitPeak, data.locked ? 1 : 0, data.id)
      return data.id
    }
    const res = d.prepare(`INSERT INTO ref_stages (work_id, seq, title, from_chapter, to_chapter, goal, antagonist, entry_hook, exit_peak, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data.workId, data.seq, data.title, data.fromChapter, data.toChapter, data.goal, data.antagonist, data.entryHook, data.exitPeak, data.locked ? 1 : 0)
    return Number(res.lastInsertRowid)
  }

  static getOutline(workId: number, level: RefOutlineLevel): RefOutlineData | null {
    const r = db().prepare('SELECT * FROM ref_outlines WHERE work_id = ? AND level = ?').get(workId, level) as Record<string, unknown> | undefined
    return r ? rowToOutline(r) : null
  }

  /** 写入并把 version +1；锁定的直接拒绝（返回 false） */
  static upsertOutline(workId: number, level: RefOutlineLevel, body: string, force = false): boolean {
    const cur = ReferenceRepository.getOutline(workId, level)
    if (cur?.locked && !force) return false
    db().prepare(`
      INSERT INTO ref_outlines (work_id, level, body, version, locked, updated_at) VALUES (?, ?, ?, 1, 0, datetime('now'))
      ON CONFLICT(work_id, level) DO UPDATE SET body = excluded.body, version = ref_outlines.version + 1, updated_at = datetime('now')
    `).run(workId, level, body)
    return true
  }

  static setOutlineLocked(workId: number, level: RefOutlineLevel, locked: boolean): void {
    db().prepare('UPDATE ref_outlines SET locked = ? WHERE work_id = ? AND level = ?').run(locked ? 1 : 0, workId, level)
  }

  static insertRevision(data: RefRevisionInput): number {
    const res = db().prepare(`INSERT INTO ref_revisions (work_id, scope, target_id, instruction, before, after) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(data.workId, data.scope, data.targetId, data.instruction, data.before, data.after)
    return Number(res.lastInsertRowid)
  }

  static listRevisions(workId: number, limit = 50): RefRevisionData[] {
    const rows = db().prepare('SELECT * FROM ref_revisions WHERE work_id = ? ORDER BY id DESC LIMIT ?').all(workId, limit) as Record<string, unknown>[]
    return rows.map(rowToRevision)
  }
}
