/**
 * 图片文件清理工具（主进程）
 *
 * 文生图产物统一落在 {projectPath}/.vela/images/ 下，数据库仅存路径。
 * 删除/替换记录时需要同步清理磁盘文件，否则会堆积孤儿图片。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getCurrentProjectPath } from '../database'
import { canonicalizePath, isPathInside, isSamePath } from '../path-guard'

/**
 * 安全删除一张配图/人设图的磁盘文件：
 * 仅当路径确实位于当前项目的 .vela/images 目录内时才删除——
 * 库里的路径可能是脏数据，也可能指向项目被复制前的旧位置（那是另一份副本的文件，不能删）。
 * 删除失败静默忽略（文件可能已不存在）。
 */
export function safeUnlinkImage(filePath: string | undefined | null): void {
    if (!filePath || !path.isAbsolute(filePath)) return
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return
    const imagesDir = canonicalizePath(path.join(projectPath, '.vela', 'images'))
    const target = canonicalizePath(filePath)
    // 必须是图片目录里的文件，不能是目录本身
    if (isSamePath(target, imagesDir) || !isPathInside(target, imagesDir)) return
    try {
        fs.unlinkSync(target)
    } catch { /* 文件不存在或已删除，忽略 */ }
}
