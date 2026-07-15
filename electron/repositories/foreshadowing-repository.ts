/**
 * ForeshadowingRepository — 伏笔/线索台账 (foreshadowings 表)
 *
 * 追踪伏笔的"埋设 → 回收"生命周期，供写稿注入未回收伏笔、审稿检查漏收、
 * 定稿后处理自动抽取与标记回收。
 */
import { getProjectDb } from '../database'

/** DB 行类型（蛇形命名） */
interface ForeshadowingRow {
  id: number
  content: string
  planted_chapter: number
  expected_chapter: number | null
  status: string
  paid_chapter: number | null
  notes: string
  created_at: string
  updated_at: string
}

/** 前端使用的驼峰接口 */
export interface ForeshadowingData {
  id: number
  content: string
  plantedChapter: number
  expectedChapter: number | null
  status: 'open' | 'paid' | 'abandoned'
  paidChapter: number | null
  notes: string
  createdAt: string
  updatedAt: string
}

function rowToData(row: ForeshadowingRow): ForeshadowingData {
  return {
    id: row.id,
    content: row.content,
    plantedChapter: row.planted_chapter,
    expectedChapter: row.expected_chapter,
    status: (row.status as ForeshadowingData['status']) || 'open',
    paidChapter: row.paid_chapter,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ForeshadowingRepository {
  /** 全部伏笔（按埋设章节排序） */
  static getAll(): ForeshadowingData[] {
    const db = getProjectDb()
    if (!db) return []
    const rows = db.prepare(
      'SELECT * FROM foreshadowings ORDER BY planted_chapter ASC, id ASC'
    ).all() as ForeshadowingRow[]
    return rows.map(rowToData)
  }

  /** 未回收伏笔（status=open，按预期回收章节/埋设章节排序） */
  static getOpen(): ForeshadowingData[] {
    const db = getProjectDb()
    if (!db) return []
    const rows = db.prepare(
      `SELECT * FROM foreshadowings WHERE status = 'open'
       ORDER BY COALESCE(expected_chapter, 999999) ASC, planted_chapter ASC, id ASC`
    ).all() as ForeshadowingRow[]
    return rows.map(rowToData)
  }

  /** 新建伏笔，返回自增 id */
  static create(data: {
    content: string
    plantedChapter: number
    expectedChapter?: number | null
    notes?: string
  }): number {
    const db = getProjectDb()
    if (!db) return -1
    const info = db.prepare(`
      INSERT INTO foreshadowings (content, planted_chapter, expected_chapter, status, notes)
      VALUES (?, ?, ?, 'open', ?)
    `).run(
      data.content,
      data.plantedChapter,
      data.expectedChapter ?? null,
      data.notes ?? '',
    )
    return Number(info.lastInsertRowid)
  }

  /** 标记为已回收 */
  static markPaid(id: number, paidChapter: number): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`
      UPDATE foreshadowings
      SET status = 'paid', paid_chapter = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(paidChapter, id)
  }

  /** 全量更新一条伏笔（供 UI 编辑） */
  static update(data: ForeshadowingData): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`
      UPDATE foreshadowings
      SET content = ?, planted_chapter = ?, expected_chapter = ?, status = ?,
          paid_chapter = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      data.content,
      data.plantedChapter,
      data.expectedChapter ?? null,
      data.status,
      data.paidChapter ?? null,
      data.notes,
      data.id,
    )
  }

  /** 删除 */
  static remove(id: number): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare('DELETE FROM foreshadowings WHERE id = ?').run(id)
  }
}
