/**
 * SettingModuleRepository — 设定纲要模块 (setting_modules 表)
 *
 * 一个模块 = 一条「世界怎么运转」的规则文档（四格 Markdown）。
 * 注入方式决定它怎样进提示词：常驻走摘要，按需走知识库检索，关闭则两边都不进。
 */
import { getProjectDb } from '../database'

export type SettingInjectMode = 'always' | 'retrieval' | 'off'

export interface SettingModuleData {
    id: number
    key: string
    title: string
    sortOrder: number
    injectMode: SettingInjectMode
    body: string
    summary: string
    source: 'ai' | 'user'
    kbDocId: string
    updatedAt: string
}

/** 新建时 id 可省略（传 0 或不传），返回落库后的 id */
export type SettingModuleInput = Omit<SettingModuleData, 'id' | 'updatedAt'> & { id?: number }

const MODES: SettingInjectMode[] = ['always', 'retrieval', 'off']

function rowToData(row: Record<string, unknown>): SettingModuleData {
    const mode = String(row.inject_mode ?? 'retrieval') as SettingInjectMode
    return {
        id: row.id as number,
        key: String(row.key ?? ''),
        title: String(row.title ?? ''),
        sortOrder: Number(row.sort_order ?? 0),
        injectMode: MODES.includes(mode) ? mode : 'retrieval',
        body: String(row.body ?? ''),
        summary: String(row.summary ?? ''),
        source: row.source === 'ai' ? 'ai' : 'user',
        kbDocId: String(row.kb_doc_id ?? ''),
        updatedAt: String(row.updated_at ?? ''),
    }
}

export class SettingModuleRepository {
    static list(): SettingModuleData[] {
        const db = getProjectDb()
        if (!db) return []
        const rows = db.prepare(
            'SELECT * FROM setting_modules ORDER BY sort_order ASC, id ASC'
        ).all() as Record<string, unknown>[]
        return rows.map(rowToData)
    }

    static get(id: number): SettingModuleData | null {
        const db = getProjectDb()
        if (!db) return null
        const row = db.prepare('SELECT * FROM setting_modules WHERE id = ?').get(id) as
            | Record<string, unknown>
            | undefined
        return row ? rowToData(row) : null
    }

    /** 插入或按 id 更新；返回模块 id */
    static upsert(data: SettingModuleInput): number {
        const db = getProjectDb()
        if (!db) throw new Error('[SettingModuleRepository] 数据库未连接')
        const mode = MODES.includes(data.injectMode) ? data.injectMode : 'retrieval'
        if (data.id && data.id > 0) {
            db.prepare(`
        UPDATE setting_modules
        SET key = ?, title = ?, sort_order = ?, inject_mode = ?, body = ?, summary = ?,
            source = ?, kb_doc_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(data.key, data.title, data.sortOrder, mode, data.body, data.summary,
                data.source, data.kbDocId, data.id)
            return data.id
        }
        const result = db.prepare(`
      INSERT INTO setting_modules (key, title, sort_order, inject_mode, body, summary, source, kb_doc_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title,
        sort_order = excluded.sort_order,
        inject_mode = excluded.inject_mode,
        body = excluded.body,
        summary = excluded.summary,
        source = excluded.source,
        kb_doc_id = excluded.kb_doc_id,
        updated_at = datetime('now')
    `).run(data.key, data.title, data.sortOrder, mode, data.body, data.summary, data.source, data.kbDocId)
        if (Number(result.changes) > 0 && Number(result.lastInsertRowid) > 0) {
            // 冲突更新时 lastInsertRowid 不可靠，按 key 回查
            const row = db.prepare('SELECT id FROM setting_modules WHERE key = ?').get(data.key) as { id: number } | undefined
            return row?.id ?? Number(result.lastInsertRowid)
        }
        const row = db.prepare('SELECT id FROM setting_modules WHERE key = ?').get(data.key) as { id: number } | undefined
        return row?.id ?? 0
    }

    static delete(id: number): void {
        const db = getProjectDb()
        if (!db) return
        db.prepare('DELETE FROM setting_modules WHERE id = ?').run(id)
    }

    /** 按传入的 id 顺序重排 sort_order */
    static reorder(ids: number[]): void {
        const db = getProjectDb()
        if (!db) return
        const stmt = db.prepare("UPDATE setting_modules SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
        const tx = db.transaction((list: number[]) => {
            list.forEach((id, idx) => stmt.run(idx, id))
        })
        tx(ids)
    }
}
