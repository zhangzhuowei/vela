/**
 * 图片文件清理工具（主进程）
 *
 * 文生图产物统一落在 {projectPath}/.vela/images/ 下，数据库仅存路径。
 * 删除/替换记录时需要同步清理磁盘文件，否则会堆积孤儿图片。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 安全删除一张配图/人设图的磁盘文件：
 * 仅当路径确实位于某个 .vela/images 目录内时才删除，
 * 避免因脏数据/异常路径误删无关文件。删除失败静默忽略（文件可能已不存在）。
 */
export function safeUnlinkImage(filePath: string | undefined | null): void {
    if (!filePath) return
    const normalized = path.normalize(filePath)
    const marker = path.join('.vela', 'images') + path.sep
    if (!normalized.includes(marker)) return
    try {
        fs.unlinkSync(normalized)
    } catch { /* 文件不存在或已删除，忽略 */ }
}
