/**
 * SceneRepository — 对话创作模式的场与回合 (scenes / scene_turns 表)
 *
 * 场是对话循环的基本单位：场内对话 → 收场蒸馏 → 正文写入 scenes.body。
 * 章级进行中角色状态存放在 blueprints.working_state（每章一行）。
 */
import { getProjectDb } from '../database'
import { shouldResetChapterWorkingState } from '../../src/services/dialogue/working-state-policy'

export interface SceneData {
    id: number
    chapterNumber: number
    seq: number
    title: string
    goal: string
    status: 'open' | 'distilled'
    body: string
    line: string
    summary: string
    createdAt: string
    updatedAt: string
}

export interface SceneTurnData {
    id: number
    sceneId: number
    role: 'user' | 'assistant'
    content: string
    statePatch: Record<string, Record<string, string>>
    createdAt: string
}

function rowToScene(row: Record<string, unknown>): SceneData {
    return {
        id: row.id as number,
        chapterNumber: row.chapter_number as number,
        seq: row.seq as number,
        title: row.title as string,
        goal: row.goal as string,
        status: row.status as 'open' | 'distilled',
        body: row.body as string,
        line: (row.line as string) ?? '',
        summary: (row.summary as string) ?? '',
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    }
}

function rowToTurn(row: Record<string, unknown>): SceneTurnData {
    let patch: Record<string, Record<string, string>> = {}
    try {
        const parsed = JSON.parse(String(row.state_patch || '{}'))
        if (parsed && typeof parsed === 'object') patch = parsed
    } catch { /* 容错：坏 JSON 当空补丁 */ }
    return {
        id: row.id as number,
        sceneId: row.scene_id as number,
        role: row.role as 'user' | 'assistant',
        content: row.content as string,
        statePatch: patch,
        createdAt: row.created_at as string,
    }
}

export class SceneRepository {
    /** 列出章节的所有场（按场序） */
    static listByChapter(chapterNumber: number): SceneData[] {
        const db = getProjectDb()
        if (!db) return []
        const rows = db.prepare(
            'SELECT * FROM scenes WHERE chapter_number = ? ORDER BY seq ASC'
        ).all(chapterNumber) as Record<string, unknown>[]
        return rows.map(rowToScene)
    }

    static get(id: number): SceneData | null {
        const db = getProjectDb()
        if (!db) return null
        const row = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as
            | Record<string, unknown>
            | undefined
        return row ? rowToScene(row) : null
    }

    /** 建场（场序自动排到本章末尾） */
    static create(chapterNumber: number, title: string, goal: string): number {
        const db = getProjectDb()
        if (!db) throw new Error('[SceneRepository] 数据库未连接')
        const seqRow = db.prepare(
            'SELECT MAX(seq) as maxSeq FROM scenes WHERE chapter_number = ?'
        ).get(chapterNumber) as { maxSeq: number | null }
        const result = db.prepare(`
      INSERT INTO scenes (chapter_number, seq, title, goal)
      VALUES (?, ?, ?, ?)
    `).run(chapterNumber, (seqRow.maxSeq ?? 0) + 1, title, goal)
        return Number(result.lastInsertRowid)
    }

    static update(id: number, patch: { title?: string; goal?: string; line?: string }): void {
        const db = getProjectDb()
        if (!db) return
        const sets: string[] = []
        const values: unknown[] = []
        if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title) }
        if (patch.goal !== undefined) { sets.push('goal = ?'); values.push(patch.goal) }
        if (patch.line !== undefined) { sets.push('line = ?'); values.push(patch.line) }
        if (sets.length === 0) return
        sets.push("updated_at = datetime('now')")
        values.push(id)
        db.prepare(`UPDATE scenes SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }

    /** 多线联动：同章、同线、seq 更小且已收场的最近一场（取前情摘要用） */
    static prevInLine(chapterNumber: number, line: string, beforeSeq: number): SceneData | null {
        const db = getProjectDb()
        if (!db || !line) return null
        const row = db.prepare(`
      SELECT * FROM scenes
      WHERE chapter_number = ? AND line = ? AND seq < ? AND status = 'distilled'
      ORDER BY seq DESC LIMIT 1
    `).get(chapterNumber, line, beforeSeq) as Record<string, unknown> | undefined
        return row ? rowToScene(row) : null
    }

    /** 多线联动：缓存场正文摘要 */
    static setSummary(id: number, summary: string): void {
        const db = getProjectDb()
        if (!db) return
        db.prepare(`UPDATE scenes SET summary = ? WHERE id = ?`).run(summary, id)
    }

    /** 删场（回合级联删除）；已收场的场不可删，防止已蒸馏正文意外丢失 */
    static delete(id: number): void {
        const db = getProjectDb()
        if (!db) return
        const scene = SceneRepository.get(id)
        if (!scene) return
        if (scene.status === 'distilled') {
            throw new Error('场已收场，不能删除（先在草稿层处理）')
        }
        const chapterNumber = scene.chapterNumber
        db.prepare('DELETE FROM scenes WHERE id = ?').run(id)
        const left = db.prepare(
            'SELECT COUNT(*) as n FROM scenes WHERE chapter_number = ?'
        ).get(chapterNumber) as { n: number }
        if (shouldResetChapterWorkingState(left.n)) {
            SceneRepository.setWorkingState(chapterNumber, {})
        }
    }

    /** 收场：写入蒸馏正文。空正文拒绝，保证失败不落盘 */
    static commit(id: number, body: string): void {
        const db = getProjectDb()
        if (!db) throw new Error('[SceneRepository] 数据库未连接')
        if (!body || !body.trim()) throw new Error('收场正文为空，拒绝落盘')
        db.prepare(`
      UPDATE scenes SET body = ?, status = 'distilled', updated_at = datetime('now')
      WHERE id = ?
    `).run(body.trim(), id)
    }

    /** 重开已收场的场（正文保留，允许继续对话后重蒸） */
    static reopen(id: number): void {
        const db = getProjectDb()
        if (!db) return
        db.prepare(
            `UPDATE scenes SET status = 'open', updated_at = datetime('now') WHERE id = ?`
        ).run(id)
    }

    // ===== 回合 =====

    static listTurns(sceneId: number): SceneTurnData[] {
        const db = getProjectDb()
        if (!db) return []
        const rows = db.prepare(
            'SELECT * FROM scene_turns WHERE scene_id = ? ORDER BY id ASC'
        ).all(sceneId) as Record<string, unknown>[]
        return rows.map(rowToTurn)
    }

    static addTurn(
        sceneId: number,
        role: 'user' | 'assistant',
        content: string,
        statePatch?: Record<string, Record<string, string>>
    ): number {
        const db = getProjectDb()
        if (!db) throw new Error('[SceneRepository] 数据库未连接')
        const result = db.prepare(`
      INSERT INTO scene_turns (scene_id, role, content, state_patch)
      VALUES (?, ?, ?, ?)
    `).run(sceneId, role, content, JSON.stringify(statePatch ?? {}))
        return Number(result.lastInsertRowid)
    }

    /** 删除场内最后一轮（重试用：删掉 assistant 或整对） */
    static deleteLastTurn(sceneId: number): void {
        const db = getProjectDb()
        if (!db) return
        db.prepare(`
      DELETE FROM scene_turns WHERE id = (
        SELECT MAX(id) FROM scene_turns WHERE scene_id = ?
      )
    `).run(sceneId)
    }

    // ===== 章级进行中状态（blueprints.working_state） =====

    static getWorkingState(chapterNumber: number): Record<string, Record<string, string>> {
        const db = getProjectDb()
        if (!db) return {}
        const row = db.prepare(
            'SELECT working_state FROM blueprints WHERE chapter_number = ?'
        ).get(chapterNumber) as { working_state: string } | undefined
        if (!row) return {}
        try {
            const parsed = JSON.parse(row.working_state || '{}')
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
            return {}
        }
    }

    static setWorkingState(
        chapterNumber: number,
        state: Record<string, Record<string, string>>
    ): void {
        const db = getProjectDb()
        if (!db) return
        // 蓝图行可能还不存在（用户直接开对话），INSERT 兜底
        db.prepare(`
      INSERT INTO blueprints (chapter_number, title, working_state)
      VALUES (?, '', ?)
      ON CONFLICT(chapter_number) DO UPDATE SET
        working_state = excluded.working_state,
        updated_at = datetime('now')
    `).run(chapterNumber, JSON.stringify(state))
    }

    /** 章级创作模式覆盖（'' = 继承工程默认） */
    static getChapterMode(chapterNumber: number): string {
        const db = getProjectDb()
        if (!db) return ''
        const row = db.prepare(
            'SELECT creation_mode FROM blueprints WHERE chapter_number = ?'
        ).get(chapterNumber) as { creation_mode: string } | undefined
        return row?.creation_mode ?? ''
    }

    static setChapterMode(chapterNumber: number, mode: string): void {
        const db = getProjectDb()
        if (!db) return
        db.prepare(`
      INSERT INTO blueprints (chapter_number, title, creation_mode)
      VALUES (?, '', ?)
      ON CONFLICT(chapter_number) DO UPDATE SET
        creation_mode = excluded.creation_mode,
        updated_at = datetime('now')
    `).run(chapterNumber, mode)
    }
}
