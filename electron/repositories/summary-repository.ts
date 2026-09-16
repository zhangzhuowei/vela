import { getProjectDb } from '../database'

export class SummaryRepository {
  /** 保存角色状态快照 */
  static saveSnapshot(chapterNumber: number, characterStates: string): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`
      INSERT INTO summary_snapshots (chapter_number, character_states)
      VALUES (?, ?)
    `).run(chapterNumber, characterStates)
  }

  /** 获取最新角色状态快照 */
  static getLatestSnapshot(): { characterStates: string; chapterNumber: number } | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(
      'SELECT character_states as characterStates, chapter_number as chapterNumber FROM summary_snapshots ORDER BY id DESC LIMIT 1'
    ).get() as { characterStates: string; chapterNumber: number } | undefined
    return row ?? null
  }

  /** 锚点章（含）之前最近一次正文定稿时的角色状态快照 */
  static getSnapshotAtOrBefore(chapterNumber: number): { characterStates: string; chapterNumber: number } | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(
      'SELECT character_states, chapter_number FROM summary_snapshots WHERE chapter_number > 0 AND chapter_number <= ? ORDER BY chapter_number DESC, id DESC LIMIT 1'
    ).get(chapterNumber) as { character_states: string; chapter_number: number } | undefined
    return row ? { characterStates: row.character_states, chapterNumber: row.chapter_number } : null
  }
}
