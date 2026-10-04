import { ipcMain } from 'electron'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { FileNode } from '../../src/shared/ipc-channels'
import { assertPathAccess, checkPathAccess } from '../path-guard'

// 全局文件操作锁（按文件绝对路径分配 Mutex 队列）
const fileMutexMap = new Map<string, Promise<void>>()

/** 目录树最大递归深度（项目根为第 0 层） */
const LIST_DIR_MAX_DEPTH = 8
/** 目录树最多返回的条目数：误把很大的目录当项目打开时，避免主进程长时间同步遍历 */
const LIST_DIR_MAX_ENTRIES = 5000

/** 互斥锁执行器：确保同一文件的读写完全串行排队 */
async function withFileMutex<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  // Normalize path across OS
  const normalPath = path.resolve(filePath)
  const previousTask = fileMutexMap.get(normalPath) || Promise.resolve()
  
  const currentTask = (async () => {
    try {
      await previousTask
    } catch { /* 前置任务错误不影响后续任务启动 */ }
    return task()
  })()

  // 缓存 stored promise 引用，供 finally 比较用
  const stored = currentTask.then(() => {}).catch(() => {})
  fileMutexMap.set(normalPath, stored)
  
  try {
    return await currentTask
  } finally {
    // 垃圾回收防御：如果当前任务是最后在等待的，则移除记录
    if (fileMutexMap.get(normalPath) === stored) {
      fileMutexMap.delete(normalPath)
    }
  }
}

export function registerFSController() {
  // 导出 EPUB（零依赖，在主进程构建 ZIP 二进制并写盘）
  ipcMain.handle('export:epub', async (_event, payload: {
    title: string
    author: string
    language?: string
    outputPath: string
    chapters: Array<{ title: string; content: string }>
  }) => {
    try {
      if (!payload.chapters || payload.chapters.length === 0) {
        return { success: false, error: '无可导出的章节' }
      }
      const outputPath = assertPathAccess(payload.outputPath, 'write')
      const { buildEpub } = await import('../utils/epub-builder')
      const buf = buildEpub({
        title: payload.title,
        author: payload.author,
        language: payload.language,
        chapters: payload.chapters,
      })
      await fsPromises.mkdir(path.dirname(outputPath), { recursive: true })
      await fsPromises.writeFile(outputPath, buf)
      return { success: true, path: payload.outputPath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 安全的异步读取
  ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
    try {
      const target = assertPathAccess(filePath, 'read')
      return await withFileMutex(target, async () => {
        const content = await fsPromises.readFile(target, 'utf-8')
        return { success: true, content }
      })
    } catch (error) {
      return { success: false, content: '', error: String(error) }
    }
  })

  // 跨平台绝对安全异步写入（防踩空）
  ipcMain.handle('fs:write-file', async (_event, filePath: string, content: string) => {
    try {
      const target = assertPathAccess(filePath, 'write')
      return await withFileMutex(target, async () => {
        await fsPromises.mkdir(path.dirname(target), { recursive: true })
        // 先写到临时文件再原位替换，绝对防止 0KB 碎屑踩空现象
        const tempPath = `${target}.${Date.now()}.tmp`
        try {
          await fsPromises.writeFile(tempPath, content, 'utf-8')
          await fsPromises.rename(tempPath, target)
        } catch (e) {
          // 替换失败时清理临时文件，不在目录里留下 .tmp 碎片
          await fsPromises.rm(tempPath, { force: true }).catch(() => { })
          throw e
        }
        return { success: true }
      })
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:list-dir', async (_event, dirPath: string): Promise<FileNode[]> => {
    const check = checkPathAccess(dirPath, 'read')
    if (!check.ok) return []
    try {
      const budget = { remaining: LIST_DIR_MAX_ENTRIES, truncated: false }
      const tree = readDirRecursive(check.path, 0, budget)
      if (budget.truncated) {
        console.warn(`[Vela FS] 目录条目过多，只返回前 ${LIST_DIR_MAX_ENTRIES} 项 / ${LIST_DIR_MAX_DEPTH} 层：${check.path}`)
      }
      return tree
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:mkdir', async (_event, dirPath: string) => {
    try {
      const target = assertPathAccess(dirPath, 'write')
      fs.mkdirSync(target, { recursive: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:check-exists', async (_event, filePath: string) => {
    const check = checkPathAccess(filePath, 'read')
    return check.ok ? fs.existsSync(check.path) : false
  })

  ipcMain.handle('fs:read-json', async (_event, filePath: string) => {
    try {
      const target = assertPathAccess(filePath, 'read')
      return await withFileMutex(target, async () => {
        const content = await fsPromises.readFile(target, 'utf-8')
        return { success: true, data: JSON.parse(content) }
      })
    } catch (error) {
      return { success: false, data: null, error: String(error) }
    }
  })

  ipcMain.handle('fs:write-json', async (_event, filePath: string, data: unknown) => {
    try {
      const target = assertPathAccess(filePath, 'write')
      return await withFileMutex(target, async () => {
        await fsPromises.mkdir(path.dirname(target), { recursive: true })
        const tempPath = `${target}.${Date.now()}.tmp`
        try {
          await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8')
          await fsPromises.rename(tempPath, target)
        } catch (e) {
          await fsPromises.rm(tempPath, { force: true }).catch(() => { })
          throw e
        }
        return { success: true }
      })
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

/**
 * 递归列目录（跳过以 . 开头的条目）。
 * 深度与总条目数都有上限；读不了的子目录（权限不足等）按空目录处理，不让整棵树失败。
 */
function readDirRecursive(dirPath: string, depth: number, budget: { remaining: number; truncated: boolean }): FileNode[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (e) {
    if (depth === 0) throw e
    return []
  }
  const sorted = entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })

  const nodes: FileNode[] = []
  for (const entry of sorted) {
    if (budget.remaining <= 0) {
      budget.truncated = true
      break
    }
    budget.remaining--
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      let children: FileNode[] = []
      if (depth + 1 < LIST_DIR_MAX_DEPTH) {
        children = readDirRecursive(fullPath, depth + 1, budget)
      } else {
        budget.truncated = true
      }
      nodes.push({ name: entry.name, path: fullPath, isDir: true, children })
    } else {
      nodes.push({ name: entry.name, path: fullPath, isDir: false })
    }
  }
  return nodes
}
