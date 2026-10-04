/**
 * 项目数据库自动滚动备份
 *
 * 打开项目后、以及项目保持打开期间每小时检查一次：距上一份自动备份超过 AUTO_BACKUP_MIN_INTERVAL_MS
 * 就在后台做一份（SQLite 在线备份，分批复制，不长时间阻塞主进程），只保留最新 AUTO_BACKUP_KEEP 份。
 * 正文、草稿、角色卡、伏笔都在这个库里，这是误删 / 库文件损坏时唯一的恢复手段。
 */
import fs from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'
import { snapshotDatabase, listBackups, pruneBackups } from './db-backup'

/** 自动备份的文件类别（文件名 vela-auto-<时间戳>.db） */
export const AUTO_BACKUP_LABEL = 'auto'
/** 两次自动备份的最小间隔 */
const AUTO_BACKUP_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 项目打开期间的检查频率 */
const AUTO_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000
/** 打开项目后延迟一会儿再检查，避开打开时的读写高峰 */
const AUTO_BACKUP_START_DELAY_MS = 10 * 1000
/** 保留的自动备份份数 */
const AUTO_BACKUP_KEEP = 7

interface Session {
  db: BetterSqlite3.Database
  projectPath: string
  startTimer: NodeJS.Timeout
  checkTimer: NodeJS.Timeout
}

let session: Session | null = null
let running = false

/** 最近一份自动备份的时间（毫秒）；没有则返回 null */
function latestBackupTime(projectPath: string): number | null {
  const files = listBackups(projectPath, AUTO_BACKUP_LABEL)
  const latest = files[files.length - 1]
  if (!latest) return null
  try {
    return fs.statSync(latest).mtimeMs
  } catch {
    return null
  }
}

/**
 * 立即做一份备份（不看间隔）。返回备份文件路径。
 * 供自动检查与「立即备份」共用；同一时间只跑一份。
 */
export async function backupNow(db: BetterSqlite3.Database, projectPath: string, label = AUTO_BACKUP_LABEL, keep = AUTO_BACKUP_KEEP): Promise<string> {
  if (running) throw new Error('已有备份正在进行，请稍后再试')
  running = true
  try {
    const file = await snapshotDatabase(db, projectPath, label)
    pruneBackups(projectPath, label, keep)
    return file
  } finally {
    running = false
  }
}

async function backupIfDue(s: Session): Promise<void> {
  // 期间切换 / 关闭了项目：这份会话已作废
  if (session !== s || !s.db.open || running) return
  const last = latestBackupTime(s.projectPath)
  if (last !== null && Date.now() - last < AUTO_BACKUP_MIN_INTERVAL_MS) return
  try {
    const file = await backupNow(s.db, s.projectPath)
    console.log(`[Vela DB] 自动备份完成: ${file}`)
  } catch (e) {
    console.warn('[Vela DB] 自动备份失败（下次检查时重试）:', e)
  }
}

/** 打开项目数据库后调用：开始该项目的自动备份 */
export function startAutoBackup(db: BetterSqlite3.Database, projectPath: string): void {
  stopAutoBackup()
  const s = { db, projectPath } as Session
  s.startTimer = setTimeout(() => { void backupIfDue(s) }, AUTO_BACKUP_START_DELAY_MS)
  s.checkTimer = setInterval(() => { void backupIfDue(s) }, AUTO_BACKUP_CHECK_INTERVAL_MS)
  // 定时器不单独撑住进程（退出应用 / 测试结束时不必等它）
  s.startTimer.unref?.()
  s.checkTimer.unref?.()
  session = s
}

/** 关闭项目数据库前调用：停止自动备份 */
export function stopAutoBackup(): void {
  if (!session) return
  clearTimeout(session.startTimer)
  clearInterval(session.checkTimer)
  session = null
}
