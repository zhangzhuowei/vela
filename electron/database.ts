/**
 * Vela SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { closeAllConnections as closeAllLanceConnections } from './vector-store'
import { snapshotDatabaseSync, pruneBackups } from './db-backup'
import { startAutoBackup, stopAutoBackup } from './db-auto-backup'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import type BetterSqlite3 from 'better-sqlite3'

let projectDb: BetterSqlite3.Database | null = null
/** 与 projectDb 对应的项目根目录 */
let currentProjectPath: string | null = null

/** 初始化项目数据库（打开项目时调用） */
export function initProjectDatabase(projectPath: string): void {
  closeProjectDatabase()

  const dbPath = path.join(projectPath, '.vela', 'vela.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  projectDb = new Database(dbPath)
  projectDb.pragma('journal_mode = WAL')
  projectDb.pragma('foreign_keys = ON')
  // 并发写碰撞（批量定稿写回 vs UI 保存）时自动等待重试，而非直接抛 SQLITE_BUSY
  projectDb.pragma('busy_timeout = 5000')

  // 创建表结构
  createTables(projectDb)
  // 增量列迁移（对旧项目库补齐新列）
  migrateSchema(projectDb)
  // 对老库执行 schema 迁移（加 UNIQUE 约束等）；库版本比应用新时抛错，拒绝打开
  try {
    migrateProjectDatabase(projectDb, projectPath)
  } catch (e) {
    projectDb.close()
    projectDb = null
    throw e
  }
  currentProjectPath = projectPath
  // 后台滚动备份（间隔与保留份数见 db-auto-backup.ts）
  startAutoBackup(projectDb, projectPath)
  console.log(`[Vela DB] 项目数据库已打开: ${dbPath}`)
}

/**
 * 关闭项目数据库。
 * LanceDB 连接与 SQLite 同步关闭：此前切换/关闭项目只关 SQLite，
 * LanceDB 连接残留在池中不释放句柄。
 */
export function closeProjectDatabase(): void {
  stopAutoBackup()
  if (projectDb) {
    projectDb.close()
    projectDb = null
  }
  currentProjectPath = null
  closeAllLanceConnections()
}

/** 当前打开的项目根目录（数据库未打开时为 null） */
export function getCurrentProjectPath(): string | null {
  return currentProjectPath
}

function indexExists(db: BetterSqlite3.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name)
}

/** v0 → v1：给 canon 表加唯一约束（先按约束口径去重，保留 id 最小的那条） */
function migrateV0ToV1(db: BetterSqlite3.Database): void {
  if (!indexExists(db, 'idx_canon_timeline_unique')) {
    db.exec(`
      DELETE FROM canon_timeline_events
      WHERE id NOT IN (
        SELECT MIN(id) FROM canon_timeline_events
        GROUP BY chapter_number, sequence
      )
    `)
    db.exec(`CREATE UNIQUE INDEX idx_canon_timeline_unique ON canon_timeline_events(chapter_number, sequence)`)
  }
  if (!indexExists(db, 'idx_canon_facts_unique')) {
    db.exec(`
      DELETE FROM canon_facts
      WHERE id NOT IN (
        SELECT MIN(id) FROM canon_facts
        WHERE statement IS NOT NULL AND statement != ''
        GROUP BY LOWER(TRIM(statement))
      )
    `)
    db.exec(`CREATE UNIQUE INDEX idx_canon_facts_unique ON canon_facts(statement COLLATE NOCASE)`)
  }
  if (!indexExists(db, 'idx_canon_plot_unique')) {
    db.exec(`
      DELETE FROM canon_plot_lines
      WHERE id NOT IN (
        SELECT MIN(id) FROM canon_plot_lines
        GROUP BY LOWER(TRIM(name))
      )
    `)
    db.exec(`CREATE UNIQUE INDEX idx_canon_plot_unique ON canon_plot_lines(name COLLATE NOCASE)`)
  }
}

/**
 * 有序迁移列表：第 i 项把 user_version 从 i 升到 i + 1。
 * 新增迁移只能追加到末尾，已发布的迁移不要修改。
 */
const MIGRATIONS: Array<(db: BetterSqlite3.Database) => void> = [
  migrateV0ToV1,
]

/** 当前应用支持的 schema 版本号 */
export const SCHEMA_VERSION = MIGRATIONS.length

/** 迁移前备份保留份数 */
const PRE_MIGRATION_BACKUP_KEEP = 3

/**
 * 对老库执行 schema 迁移。
 * - 库版本比应用新（被新版 Vela 升级过）：拒绝打开，避免旧版本按旧结构写坏数据
 * - 迁移会改写数据（如去重删除）：执行前先整库备份到 .vela/backups
 * - 每一步在事务里执行，成功才升版本号；失败整体回滚、保持原版本，下次打开项目时重试
 *   （此前失败只打日志、照样把版本号升上去，之后再也不会重试）
 */
function migrateProjectDatabase(db: BetterSqlite3.Database, projectPath: string): void {
  const currentVersion = Number(db.pragma('user_version', { simple: true })) || 0
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`项目数据库版本（v${currentVersion}）高于当前 Vela 支持的版本（v${SCHEMA_VERSION}），请升级 Vela 后再打开此项目`)
  }
  if (currentVersion === SCHEMA_VERSION) return

  try {
    // 新建项目（canon 表还是空的）没有可丢的数据，不必备份
    const hasCanonData = ['canon_timeline_events', 'canon_facts', 'canon_plot_lines'].some((table) =>
      !!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
    if (hasCanonData) {
      const file = snapshotDatabaseSync(db, projectPath, 'pre-migration')
      pruneBackups(projectPath, 'pre-migration', PRE_MIGRATION_BACKUP_KEEP)
      console.log(`[Vela DB] 迁移前备份: ${file}`)
    }
  } catch (e) {
    // 备份失败（磁盘满等）时不冒险改写数据，保持原版本，下次再试
    console.warn('[Vela DB] 迁移前备份失败，本次跳过 schema 迁移:', e)
    return
  }

  for (let version = currentVersion; version < SCHEMA_VERSION; version++) {
    try {
      db.transaction(() => {
        MIGRATIONS[version](db)
        db.pragma(`user_version = ${version + 1}`)
      })()
      console.log(`[Vela DB] schema 迁移完成: v${version} → v${version + 1}`)
    } catch (e) {
      console.warn(`[Vela DB] schema 迁移 v${version} → v${version + 1} 失败，已回滚，下次打开项目时重试:`, e)
      return
    }
  }
}

/** 获取当前数据库实例 */
export function getProjectDb(): BetterSqlite3.Database | null {
  return projectDb
}

/**
 * 增量列迁移：对已存在的旧项目库补齐后加的列。
 * SQLite 的 CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，故用 ALTER 补。
 */
function migrateSchema(db: BetterSqlite3.Database) {
  const addColumnIfMissing = (table: string, column: string, ddl: string) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
        console.log(`[Vela DB] 迁移：为 ${table} 补列 ${column}`)
      }
    } catch (e) {
      console.warn(`[Vela DB] 迁移 ${table}.${column} 失败:`, e)
    }
  }
  addColumnIfMissing('characters', 'speech_style', `speech_style TEXT DEFAULT ''`)
  addColumnIfMissing('characters', 'cs_known_info', `cs_known_info TEXT DEFAULT ''`)
  addColumnIfMissing('characters', 'portrait_path', `portrait_path TEXT DEFAULT ''`)
  addColumnIfMissing('characters', 'image_prompt', `image_prompt TEXT DEFAULT ''`)
  addColumnIfMissing('project_core', 'style_reference', `style_reference TEXT DEFAULT ''`)
  addColumnIfMissing('project_core', 'art_style', `art_style TEXT DEFAULT ''`)
  addColumnIfMissing('project_core', 'negative_prompt', `negative_prompt TEXT DEFAULT ''`)
  // 小说配置正文种子字段（此前误用架构四大件列存储，导致保存后清空，补齐独立列）
  addColumnIfMissing('project_core', 'core_outline', `core_outline TEXT DEFAULT ''`)
  addColumnIfMissing('project_core', 'world_setting', `world_setting TEXT DEFAULT ''`)
  addColumnIfMissing('project_core', 'protagonist_profile', `protagonist_profile TEXT DEFAULT ''`)
}

/** 创建完整表结构（9 张核心表 + 2 张沿用表） */
function createTables(db: BetterSqlite3.Database) {
  db.exec(`
    -- ============================================================
    -- 1. project_core — 项目主台账（NovelConfig + 架构四大件）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS project_core (
      id TEXT PRIMARY KEY DEFAULT 'main',
      project_name TEXT NOT NULL DEFAULT '',      -- 小说工程名
      -- [基础定位]
      genre TEXT DEFAULT '',                      -- 核心流派
      sub_genre TEXT DEFAULT '',                  -- 细分流派
      target_audience TEXT DEFAULT '',            -- 目标受众
      total_chapters INTEGER DEFAULT 100,         -- 预计总章数
      words_per_chapter INTEGER DEFAULT 3000,     -- 单章基准字数
      -- [写作技法]
      plot_structure TEXT DEFAULT 'three_act',    -- 故事模型
      narrative_pov TEXT DEFAULT 'third_limited', -- 叙事视角
      writing_style TEXT DEFAULT '',              -- 文风描述
      reference_works TEXT DEFAULT '',            -- 参考作品
      global_guidance TEXT DEFAULT '',            -- 全局行文指导
      golden_finger TEXT DEFAULT '',              -- 金手指设定
      -- [配置正文种子]（用户在「小说配置」手填，区别于下方 AI 生成的架构四大件）
      core_outline TEXT DEFAULT '',               -- 核心大纲
      world_setting TEXT DEFAULT '',              -- 世界观设定/初始设定
      protagonist_profile TEXT DEFAULT '',        -- 主角人设
      -- [架构四大件]
      premise TEXT DEFAULT '',                    -- 故事前提
      worldbuilding TEXT DEFAULT '',              -- 世界观
      characters_arch TEXT DEFAULT '',            -- 人物群像网络
      synopsis TEXT DEFAULT '',                   -- 情节总大纲
      -- [系统缓存]
      character_states TEXT DEFAULT '',           -- 全书角色动态快照
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 2. blueprints — 章节蓝图
    -- ============================================================
    CREATE TABLE IF NOT EXISTS blueprints (
      chapter_number INTEGER PRIMARY KEY,         -- 章节序号
      title TEXT NOT NULL DEFAULT '',             -- 章节标题
      role TEXT DEFAULT '',                       -- 章节角色
      purpose TEXT DEFAULT '',                    -- 核心目的
      key_events TEXT DEFAULT '',                 -- 关键事件
      characters TEXT DEFAULT '[]',               -- 出场角色 (JSON Array)
      suspense_hook TEXT DEFAULT '',              -- 悬念钩子
      user_guidance TEXT DEFAULT '',              -- 用户预设指导
      notes TEXT DEFAULT '',                      -- 后处理提取的章节要点
      notes_updated_at TEXT DEFAULT '',           -- notes 提取时间
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 3. characters — 角色卡（currentState 拍平为 cs_* 列）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,                      -- 角色名
      role TEXT DEFAULT 'supporting',             -- protagonist/antagonist/supporting/minor
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',                 -- 外貌
      personality TEXT DEFAULT '',                -- 性格
      background TEXT DEFAULT '',                 -- 背景
      abilities TEXT DEFAULT '',                  -- 能力
      motivation TEXT DEFAULT '',                 -- 动机
      relationships TEXT DEFAULT '',              -- 关系链
      arc TEXT DEFAULT '',                        -- 弧光
      notes TEXT DEFAULT '',                      -- 备忘录
      speech_style TEXT DEFAULT '',               -- 说话风格/口癖（对白一致性）
      image_prompt TEXT DEFAULT '',               -- 角色专属文生图提示词（手工补充外观特征）
      portrait_path TEXT DEFAULT '',              -- 人设图本地路径（文生图生成）
      cs_location TEXT DEFAULT '',                -- 当前位置
      cs_power_level TEXT DEFAULT '',             -- 修为境界
      cs_physical_state TEXT DEFAULT '',          -- 身体状态
      cs_mental_state TEXT DEFAULT '',            -- 心理状态
      cs_key_items TEXT DEFAULT '',               -- 关键道具
      cs_recent_events TEXT DEFAULT '',           -- 最近事件
      cs_known_info TEXT DEFAULT '',              -- 已知信息（信息差/防穿帮追踪，累积维护）
      cs_updated_at_chapter INTEGER DEFAULT 0,    -- 状态更新于第几章
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 3b. chapter_images — 章节配图（题图 header / 场景插图 scene）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS chapter_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,            -- 归属章节
      kind TEXT NOT NULL DEFAULT 'scene',         -- header（题图，每章一张） | scene（场景插图，可多张）
      path TEXT NOT NULL DEFAULT '',              -- 本地图片路径（.vela/images/）
      prompt TEXT DEFAULT '',                     -- 生成用提示词
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_images_chapter ON chapter_images(chapter_number);

    -- ============================================================
    -- 4. contents — 文本内容池（正文与元数据分离）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL DEFAULT '',              -- 正文/报告内容
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 5. drafts — 草稿主线（finalized = 定稿）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,            -- 归属章节
      version INTEGER NOT NULL,                   -- v1, v2...
      status TEXT DEFAULT 'draft',                -- draft/revised/finalized/archived
      source TEXT DEFAULT 'write',                -- write/rewrite
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_chapter ON drafts(chapter_number);
    CREATE INDEX IF NOT EXISTS idx_drafts_status_chapter ON drafts(status, chapter_number);

    -- ============================================================
    -- 6. revisions — 修稿（派生自 draft）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 父草稿 FK
      revision_index INTEGER NOT NULL,            -- r1, r2
      revision_type TEXT NOT NULL,                -- refine | review-fix
      status TEXT DEFAULT 'pending',              -- pending/merged/discarded
      merged_to_draft_id INTEGER,                 -- 合并产出的新 draft
      user_prompt TEXT DEFAULT '',                -- 用户指导
      review_source_id INTEGER,                   -- 关联审稿 ID
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_base_draft ON revisions(base_draft_id);

    -- ============================================================
    -- 7. reviews — 审稿（派生自 draft）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 审查对象 FK
      review_index INTEGER NOT NULL,              -- 审阅顺位
      content_id INTEGER NOT NULL,                -- FK -> contents
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_base_draft ON reviews(base_draft_id);

    -- ============================================================
    -- 8. post_process_runs — 后处理跑批实例
    -- ============================================================
    CREATE TABLE IF NOT EXISTS post_process_runs (
      id TEXT PRIMARY KEY,                        -- UUID
      trigger_source_type TEXT NOT NULL,           -- chapter_finalize / arch_extract
      trigger_source_id TEXT NOT NULL,             -- 章节号 / draft_id
      source_label TEXT DEFAULT '',               -- UI 标签
      all_critical_passed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_post_runs_source
      ON post_process_runs(trigger_source_type, trigger_source_id);

    -- ============================================================
    -- 9. post_process_steps — 后处理步骤明细
    -- ============================================================
    CREATE TABLE IF NOT EXISTS post_process_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,                       -- FK -> post_process_runs
      step_key TEXT NOT NULL,                     -- 步骤标识
      label TEXT DEFAULT '',                      -- 展示名称
      critical INTEGER DEFAULT 0,                 -- 是否关键步骤
      ok INTEGER DEFAULT 0,                       -- 是否完成
      error_msg TEXT DEFAULT '',
      attempt_count INTEGER DEFAULT 0,
      completed_at TEXT DEFAULT '',
      last_attempt_at TEXT DEFAULT '',
      FOREIGN KEY (run_id) REFERENCES post_process_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pp_steps_run ON post_process_steps(run_id);

    -- ============================================================
    -- 沿用表：LLM 调用记录
    -- ============================================================
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      model_name TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 沿用表：角色状态快照
    -- ============================================================
    CREATE TABLE IF NOT EXISTS summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      character_states TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 10. foreshadowings — 伏笔/线索台账（埋设→回收 追踪）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS foreshadowings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL DEFAULT '',           -- 伏笔内容描述
      planted_chapter INTEGER NOT NULL,           -- 埋设章节
      expected_chapter INTEGER,                   -- 预期回收章节（可空）
      status TEXT DEFAULT 'open',                 -- open/paid/abandoned
      paid_chapter INTEGER,                       -- 实际回收章节（可空）
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_foreshadow_status ON foreshadowings(status);

    -- ============================================================
    -- 叙事一致性 (Narrative Consistency) —— Canon Store
    -- ============================================================
    -- 结构化时间线事件
    CREATE TABLE IF NOT EXISTS canon_timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      characters TEXT DEFAULT '[]',
      location TEXT DEFAULT '',
      time_flow TEXT DEFAULT 'sequential',
      summary TEXT DEFAULT '',
      impact TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canon_timeline_chapter_seq
      ON canon_timeline_events(chapter_number, sequence);

    -- 角色状态历史（每个角色每个章节一条最新）
    CREATE TABLE IF NOT EXISTS canon_character_state (
      character TEXT PRIMARY KEY,
      location TEXT DEFAULT '',
      power_level TEXT DEFAULT '',
      physical_state TEXT DEFAULT '',
      mental_state TEXT DEFAULT '',
      key_items TEXT DEFAULT '',
      current_goal TEXT DEFAULT '',
      knowledge_json TEXT DEFAULT '[]',
      relationships_json TEXT DEFAULT '{}',
      recent_events TEXT DEFAULT '',
      updated_at_chapter INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- 长期未结剧情线
    CREATE TABLE IF NOT EXISTS canon_plot_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      started_at INTEGER DEFAULT 0,
      last_advanced_at INTEGER DEFAULT 0,
      resolved_at INTEGER,
      characters TEXT DEFAULT '[]',
      current_state TEXT DEFAULT '',
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canon_plot_status ON canon_plot_lines(status);

    -- 客观事实条目
    CREATE TABLE IF NOT EXISTS canon_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      statement TEXT NOT NULL,
      introduced_at INTEGER DEFAULT 0,
      characters TEXT DEFAULT '[]',
      evidence TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canon_facts_category ON canon_facts(category);
    CREATE INDEX IF NOT EXISTS idx_canon_facts_introduced ON canon_facts(introduced_at);

    -- 章节摘要（结构化）
    CREATE TABLE IF NOT EXISTS canon_chapter_summaries (
      chapter_number INTEGER PRIMARY KEY,
      title TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 分层摘要：卷摘要（level='arc'，每卷固定若干章）与全书摘要（level='book'，只有一条）
    -- 新表用 IF NOT EXISTS 创建即可，不需要升 schema 版本（旧版 Vela 打开时忽略这张表）
    CREATE TABLE IF NOT EXISTS canon_arc_summaries (
      level TEXT NOT NULL,
      start_chapter INTEGER NOT NULL,
      end_chapter INTEGER NOT NULL,
      title TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (level, start_chapter)
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_llm_calls_time ON llm_calls(created_at);
  `)
}
