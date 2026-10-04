/**
 * 项目数据库备份
 *
 * 备份放在 {项目}/.vela/backups/，文件名 vela-<类别>-<时间戳>.db，按类别滚动保留最新若干份。
 * 用 SQLite 自己的机制生成一致副本（包含 WAL 中已提交的数据），不能直接复制 vela.db 文件：
 * WAL 模式下最新的提交可能还在 -wal 文件里。
 */
import path from 'node:path'
import fs from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'

/** 备份目录：{项目}/.vela/backups */
export function getBackupDir(projectPath: string): string {
  return path.join(projectPath, '.vela', 'backups')
}

/** 同一毫秒内的序号：保证文件名唯一且字典序与创建顺序一致 */
let sequence = 0

function backupFilePath(projectPath: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const seq = String(sequence++ % 1000).padStart(3, '0')
  return path.join(getBackupDir(projectPath), `vela-${label}-${stamp}-${seq}.db`)
}

/**
 * 同步生成一份数据库副本（VACUUM INTO）。会阻塞到复制完成，只用于必须同步的场景（如迁移前）。
 * 返回备份文件路径。
 */
export function snapshotDatabaseSync(db: BetterSqlite3.Database, projectPath: string, label: string): string {
  fs.mkdirSync(getBackupDir(projectPath), { recursive: true })
  const file = backupFilePath(projectPath, label)
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  return file
}

/**
 * 异步生成一份数据库副本（SQLite 在线备份 API，分批复制页面，不长时间阻塞主进程）。
 * 返回备份文件路径。
 */
export async function snapshotDatabase(db: BetterSqlite3.Database, projectPath: string, label: string): Promise<string> {
  await fs.promises.mkdir(getBackupDir(projectPath), { recursive: true })
  const file = backupFilePath(projectPath, label)
  try {
    await db.backup(file)
  } catch (e) {
    // 备份中途失败（如切换项目关闭了连接）会留下不完整的文件，不能让它冒充一份可用备份
    await fs.promises.rm(file, { force: true }).catch(() => { })
    throw e
  }
  return file
}

/** 列出某类备份（按时间从旧到新） */
export function listBackups(projectPath: string, label: string): string[] {
  const dir = getBackupDir(projectPath)
  if (!fs.existsSync(dir)) return []
  const prefix = `vela-${label}-`
  // 时间戳是 ISO 格式，字典序即时间序
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort()
    .map((f) => path.join(dir, f))
}

/** 只保留某类备份中最新的 keep 份 */
export function pruneBackups(projectPath: string, label: string, keep: number): void {
  const files = listBackups(projectPath, label)
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      fs.rmSync(file, { force: true })
    } catch { /* 删不掉就留着，下次再清 */ }
  }
}
