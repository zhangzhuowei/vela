import { getProjectDb } from '../database'
import { BRANCH_BASE } from '../../src/shared/chapter-addressing'
import type { BranchKind } from '../../src/shared/chapter-addressing'

export interface BranchData {
  id: number
  name: string
  kind: BranchKind
  anchorKind: 'chapter' | 'reference_stage'
  anchorChapter: number
  premise: string
  settingDiff: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}
export type BranchInput = Omit<BranchData, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }

export interface BranchStats {
  blueprintCount: number
  draftCount: number
  finalizedCount: number
  maxFinalizedLocal: number
}

function db() {
  const d = getProjectDb()
  if (!d) throw new Error('[BranchRepository] 数据库未连接')
  return d
}

function rowToBranch(r: Record<string, unknown>): BranchData {
  return {
    id: r.id as number,
    name: String(r.name ?? ''),
    kind: r.kind === 'if' ? 'if' : 'extra',
    anchorKind: r.anchor_kind === 'reference_stage' ? 'reference_stage' : 'chapter',
    anchorChapter: Number(r.anchor_chapter ?? 0),
    premise: String(r.premise ?? ''),
    settingDiff: String(r.setting_diff ?? ''),
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }
}

export class BranchRepository {
  static list(): BranchData[] {
    const rows = db().prepare('SELECT * FROM branches ORDER BY sort_order, id').all() as Record<string, unknown>[]
    return rows.map(rowToBranch)
  }

  static get(id: number): BranchData | null {
    const r = db().prepare('SELECT * FROM branches WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? rowToBranch(r) : null
  }

  static upsert(data: BranchInput): number {
    const d = db()
    if (data.id && data.id > 0) {
      d.prepare(`UPDATE branches SET name = ?, kind = ?, anchor_kind = ?, anchor_chapter = ?, premise = ?, setting_diff = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(data.name, data.kind, data.anchorKind, data.anchorChapter, data.premise, data.settingDiff, data.sortOrder, data.id)
      return data.id
    }
    const res = d.prepare(`INSERT INTO branches (name, kind, anchor_kind, anchor_chapter, premise, setting_diff, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data.name, data.kind, data.anchorKind, data.anchorChapter, data.premise, data.settingDiff, data.sortOrder)
    return Number(res.lastInsertRowid)
  }

  /** 线内还有章节卡 / 草稿时拒绝删除（返回 false） */
  static deleteIfEmpty(id: number): boolean {
    const s = BranchRepository.stats(id)
    if (s.blueprintCount > 0 || s.draftCount > 0) return false
    db().prepare('DELETE FROM branches WHERE id = ?').run(id)
    return true
  }

  static stats(id: number): BranchStats {
    const d = db()
    const from = id * BRANCH_BASE + 1
    const to = (id + 1) * BRANCH_BASE - 1
    const bp = d.prepare('SELECT COUNT(*) AS c FROM blueprints WHERE chapter_number BETWEEN ? AND ?').get(from, to) as { c: number }
    const dr = d.prepare('SELECT COUNT(*) AS c FROM drafts WHERE chapter_number BETWEEN ? AND ?').get(from, to) as { c: number }
    const fi = d.prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(chapter_number), 0) AS m FROM drafts WHERE status = 'finalized' AND chapter_number BETWEEN ? AND ?`).get(from, to) as { c: number; m: number }
    return { blueprintCount: bp.c, draftCount: dr.c, finalizedCount: fi.c, maxFinalizedLocal: fi.m ? fi.m % BRANCH_BASE : 0 }
  }
}
