/**
 * Vela SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import type BetterSqlite3 from 'better-sqlite3'

let projectDb: BetterSqlite3.Database | null = null

/** 初始化项目数据库（打开项目时调用） */
export function initProjectDatabase(projectPath: string): void {
  closeProjectDatabase()

  const dbPath = path.join(projectPath, '.vela', 'vela.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  projectDb = new Database(dbPath)
  projectDb.pragma('journal_mode = WAL')
  projectDb.pragma('foreign_keys = ON')

  // 创建表结构
  createTables(projectDb)
  // 增量列迁移（对旧项目库补齐新列）
  migrateSchema(projectDb)
  // 对老库执行 schema 迁移（加 UNIQUE 约束等）
  migrateProjectDatabase(projectDb)
  console.log(`[Vela DB] 项目数据库已打开: ${dbPath}`)
}

/** 关闭项目数据库 */
export function closeProjectDatabase(): void {
  if (projectDb) {
    projectDb.close()
    projectDb = null
  }
}

/** 已执行的 schema 迁移版本号（用于幂等迁移） */
const SCHEMA_VERSION = 1

/** 对老库执行 schema 迁移（加 UNIQUE/CHECK 约束等） */
function migrateProjectDatabase(db: BetterSqlite3.Database): void {
  const currentVersionRow = db.prepare(
    `PRAGMA user_version`
  ).get() as { user_version: number } | undefined
  const currentVersion = currentVersionRow?.user_version ?? 0
  if (currentVersion >= SCHEMA_VERSION) return

  // v0 → v1: 给 canon 表加约束（仅当索引不存在时）
  if (currentVersion < 1) {
    const timelineUnique = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_canon_timeline_unique'`
    ).get()
    if (!timelineUnique) {
      // 注意：先尝试 CREATE UNIQUE INDEX；若有重复数据会失败，需要清理
      try {
        // 清理重复 sequence，保留 id 最小的那条
        db.exec(`
          DELETE FROM canon_timeline_events
          WHERE id NOT IN (
            SELECT MIN(id) FROM canon_timeline_events
            GROUP BY chapter_number, sequence
          )
        `)
        db.exec(`CREATE UNIQUE INDEX idx_canon_timeline_unique ON canon_timeline_events(chapter_number, sequence)`)
      } catch (e) {
        console.warn('[Vela DB] 添加 canon_timeline unique 约束失败（可能存在冲突数据）:', e)
      }
    }
    const factsUnique = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_canon_facts_unique'`
    ).get()
    if (!factsUnique) {
      try {
        db.exec(`
          DELETE FROM canon_facts
          WHERE id NOT IN (
            SELECT MIN(id) FROM canon_facts
            WHERE statement IS NOT NULL AND statement != ''
            GROUP BY LOWER(TRIM(statement))
          )
        `)
        db.exec(`CREATE UNIQUE INDEX idx_canon_facts_unique ON canon_facts(statement COLLATE NOCASE)`)
      } catch (e) {
        console.warn('[Vela DB] 添加 canon_facts unique 约束失败:', e)
      }
    }
    const plotUnique = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_canon_plot_unique'`
    ).get()
    if (!plotUnique) {
      try {
        db.exec(`
          DELETE FROM canon_plot_lines
          WHERE id NOT IN (
            SELECT MIN(id) FROM canon_plot_lines
            GROUP BY LOWER(TRIM(name))
          )
        `)
        db.exec(`CREATE UNIQUE INDEX idx_canon_plot_unique ON canon_plot_lines(name COLLATE NOCASE)`)
      } catch (e) {
        console.warn('[Vela DB] 添加 canon_plot unique 约束失败:', e)
      }
    }
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
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

    -- 章节摘要（结构化）
    CREATE TABLE IF NOT EXISTS canon_chapter_summaries (
      chapter_number INTEGER PRIMARY KEY,
      title TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_llm_calls_time ON llm_calls(created_at);
  `)
}
