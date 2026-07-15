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

    /** 新增一张配图；kind='header' 时先清掉该章旧题图，保证唯一。返回新行 id */
    static add(chapterNumber: number, kind: 'header' | 'scene', path: string, prompt: string): number {
        const db = getProjectDb()
        if (!db) return -1
        if (kind === 'header') {
            // 先取旧题图路径，删表后再清理其磁盘文件，避免孤儿图片堆积
            const oldHeaders = db.prepare(
                `SELECT path FROM chapter_images WHERE chapter_number = ? AND kind = 'header'`
            ).all(chapterNumber) as Array<{ path: string }>
            db.prepare(`DELETE FROM chapter_images WHERE chapter_number = ? AND kind = 'header'`).run(chapterNumber)
            oldHeaders.forEach((r) => safeUnlinkImage(r.path))
        }
        const res = db.prepare(
            `INSERT INTO chapter_images (chapter_number, kind, path, prompt) VALUES (?, ?, ?, ?)`
        ).run(chapterNumber, kind, path, prompt)
        return Number(res.lastInsertRowid)
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
