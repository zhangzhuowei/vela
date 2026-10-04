import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initProjectDatabase, closeProjectDatabase, getProjectDb, getCurrentProjectPath, SCHEMA_VERSION } from '../database'
import { getBackupDir, listBackups } from '../db-backup'
import { backupNow } from '../db-auto-backup'

/**
 * schema 迁移：事务化、失败不升版本、迁移前备份、拒绝打开更新版本的库。
 * 依赖 better-sqlite3 原生模块：本机 node_modules 里的是按 Electron ABI 编译的，
 * 直接用 Node 跑会因 ABI 不匹配而失败（CI 上按 Node 安装，可正常运行）。
 */
describe('项目数据库 schema 迁移', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-migrate-'))
  })

  afterEach(() => {
    closeProjectDatabase()
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  const indexNames = () => (getProjectDb()!
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_canon_%_unique'`)
    .all() as Array<{ name: string }>).map((r) => r.name).sort()

  it('新库打开后升到当前版本并建好唯一约束，且不产生无意义的备份', () => {
    initProjectDatabase(projectDir)
    const db = getProjectDb()!
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)
    expect(indexNames()).toEqual(['idx_canon_facts_unique', 'idx_canon_plot_unique', 'idx_canon_timeline_unique'])
    expect(fs.existsSync(getBackupDir(projectDir))).toBe(false)
  })

  it('老库迁移：先备份，再去重并加约束', () => {
    initProjectDatabase(projectDir)
    let db = getProjectDb()!
    // 伪造一个迁移前的老库：去掉约束、写入重复数据、版本号退回 0
    db.exec(`DROP INDEX idx_canon_facts_unique; DROP INDEX idx_canon_plot_unique; DROP INDEX idx_canon_timeline_unique;`)
    const insertFact = db.prepare(`INSERT INTO canon_facts (category, statement, introduced_at) VALUES ('identity', ?, 1)`)
    insertFact.run('林轩是青云宗弟子')
    insertFact.run('林轩是青云宗弟子')
    db.pragma('user_version = 0')
    closeProjectDatabase()

    initProjectDatabase(projectDir)
    db = getProjectDb()!
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM canon_facts`).get() as { n: number }).n).toBe(1)
    expect(indexNames()).toContain('idx_canon_facts_unique')
    const backups = fs.readdirSync(getBackupDir(projectDir))
    expect(backups.some((f) => f.startsWith('vela-pre-migration-') && f.endsWith('.db'))).toBe(true)
  })

  it('打开项目后记录当前项目路径，关闭后清空', () => {
    initProjectDatabase(projectDir)
    expect(getCurrentProjectPath()).toBe(projectDir)
    closeProjectDatabase()
    expect(getCurrentProjectPath()).toBeNull()
  })

  it('备份是可打开的完整副本，且只保留最新的若干份', async () => {
    initProjectDatabase(projectDir)
    const db = getProjectDb()!
    db.prepare(`INSERT INTO canon_facts (category, statement, introduced_at) VALUES ('identity', '备份内容', 1)`).run()

    for (let i = 0; i < 3; i++) await backupNow(db, projectDir, 'manual', 2)
    const files = listBackups(projectDir, 'manual')
    expect(files).toHaveLength(2)

    // 备份文件本身是一个完整可读的 SQLite 库
    const { createRequire } = await import('node:module')
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const copy = new Database(files[files.length - 1], { readonly: true })
    try {
      const row = copy.prepare(`SELECT statement FROM canon_facts`).get() as { statement: string }
      expect(row.statement).toBe('备份内容')
    } finally {
      copy.close()
    }
  })

  it('库版本比应用新时拒绝打开，避免旧版本写坏数据', () => {
    initProjectDatabase(projectDir)
    getProjectDb()!.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    closeProjectDatabase()

    expect(() => initProjectDatabase(projectDir)).toThrow(/高于当前 Vela 支持的版本/)
    expect(getProjectDb()).toBeNull()
  })
})
