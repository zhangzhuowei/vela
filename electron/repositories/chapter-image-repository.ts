/**
 * ChapterImageRepository — 章节配图 (chapter_images 表)
 *
 * 同时承载两类图：
 *  - header：章节题图，每章至多一张（add 时先删旧的）
 *  - scene ：场景插图，每章可多张
 * 图片文件本体存于 {projectPath}/.vela/images/，本表仅记录路径与提示词。
 */
import { getProjectDb } from '../database'
import { safeUnlinkImage } from '../utils/image-file'

export interface ChapterImageRow {
    id: number
    chapter_number: number
    kind: string
    path: string
    prompt: string
    created_at: string
}

export interface ChapterImageData {
    id: number
    chapterNumber: number
    kind: 'header' | 'scene'
    path: string
    prompt: string
    createdAt: string
}

function rowToData(row: ChapterImageRow): ChapterImageData {
    return {
        id: row.id,
        chapterNumber: row.chapter_number,
        kind: (row.kind === 'header' ? 'header' : 'scene'),
        path: row.path,
        prompt: row.prompt || '',
        createdAt: row.created_at,
    }
}

export class ChapterImageRepository {
    /** 列出某章的全部配图（题图在前，其余按时间倒序） */
    static listByChapter(chapterNumber: number): ChapterImageData[] {
        const db = getProjectDb()
        if (!db) return []
        const rows = db.prepare(
            `SELECT * FROM chapter_images WHERE chapter_number = ?
             ORDER BY CASE kind WHEN 'header' THEN 0 ELSE 1 END ASC, created_at DESC`
        ).all(chapterNumber) as ChapterImageRow[]
        return rows.map(rowToData)
    }

    /** 新增一张配图；kind='header' 时替换该章旧题图，保证唯一。返回新行 id */
    static add(chapterNumber: number, kind: 'header' | 'scene', path: string, prompt: string): number {
        const db = getProjectDb()
        if (!db) return -1

        if (kind !== 'header') {
            const res = db.prepare(
                `INSERT INTO chapter_images (chapter_number, kind, path, prompt) VALUES (?, ?, ?, ?)`
            ).run(chapterNumber, kind, path, prompt)
            return Number(res.lastInsertRowid)
        }

        // 题图替换必须「先立新、后破旧」：原实现先删行删盘再插入，
        // INSERT 一旦失败（磁盘满、约束冲突等），旧题图已经库、盘双删，永久丢失。
        // 现在插入新行与删除旧行在同一事务内完成，提交成功后才清理旧文件；
        // 事务失败则旧行与旧文件原样保留（新文件顶多成为孤儿，下次替换可覆盖）。
        let oldPaths: string[] = []
        const insertedId = db.transaction(() => {
            oldPaths = (db.prepare(
                `SELECT path FROM chapter_images WHERE chapter_number = ? AND kind = 'header'`
            ).all(chapterNumber) as Array<{ path: string }>).map((r) => r.path)

            const res = db.prepare(
                `INSERT INTO chapter_images (chapter_number, kind, path, prompt) VALUES (?, ?, ?, ?)`
            ).run(chapterNumber, kind, path, prompt)
            const newId = Number(res.lastInsertRowid)

            db.prepare(
                `DELETE FROM chapter_images WHERE chapter_number = ? AND kind = 'header' AND id != ?`
            ).run(chapterNumber, newId)
            return newId
        })()

        // 事务已提交，旧图从库中移除，此时清理磁盘文件才是安全的
        for (const p of oldPaths) {
            if (p && p !== path) safeUnlinkImage(p)
        }
        return insertedId
    }

    /** 删除一张配图 */
    static remove(id: number): void {
        const db = getProjectDb()
        if (!db) return
        // 先取路径，删表后清理磁盘文件
        const row = db.prepare(`SELECT path FROM chapter_images WHERE id = ?`).get(id) as { path: string } | undefined
        db.prepare(`DELETE FROM chapter_images WHERE id = ?`).run(id)
        if (row) safeUnlinkImage(row.path)
    }
}
