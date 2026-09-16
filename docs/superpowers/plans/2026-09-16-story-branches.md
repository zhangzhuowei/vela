# 番外 / IF 线（书级「线」维度）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。

**目标：** 让一本书除正文外可以有多条「线」：番外（不改变正史的支线 / 前传 / 日常）与 IF 线（从某章分叉的另一种走向）。每条线有自己的章节卡、草稿、定稿，写作时只读到「该线可见」的正史与本线内容，定稿只写回本线自己的范围，正文完全不受污染。

**架构：** 不给现有 `blueprints / drafts / canon_*` 加列，而是用**章号地址空间**分线：正文 1～9999，线 `id` 的章号 = `id × 10000 + 线内序号`。时间线、事实、章摘要、伏笔本身就带章号，天然按范围隔离；只需（1）新增 `branches` 表；（2）把所有「按章号筛」的读操作改为经过统一的 `ChapterVisibility`（正史 ≤ 锚点 + 本线更早章）；（3）定稿时按线跳过「当前态」类写回（角色卡、剧情线、知识库、压缩摘要）。`buildCanonContext` 内部自行解析可见性，5 个调用方（写稿 / 精修 / 按审稿修 / 审稿 / 定稿 Gate）零改动即生效。

**技术栈：** Electron + better-sqlite3、React + zustand、i18next 三语、vitest。

**已定决策**

| 项 | 决定 |
| --- | --- |
| IF 线里角色的持久变化 | 只进本线的事实 / 时间线；**角色卡永远是正史**，线内读角色状态取锚点章定稿时的快照 |
| 番外 | 支持多章 + 章节卡 + 目录生成 |
| 番外导出 | 默认「附在正文末尾的番外卷」，项目级可配置：`appendix` / `inline`（插在锚点章后）/ `separate`（单独文件）；IF 线始终单独文件 |
| 前传 | 允许锚点 = 0：读不到任何正文章，只读架构 / 角色卡初始设定 / 设定纲要 |
| 排期 | 本计划先于「参考作品拆书」；线的锚点字段预留 `anchorKind`，将来用法 B 用 `reference_stage` |
| 知识库 | 番外 / IF 定稿**不进知识库**；写稿时仍可检索正文 |
| 伏笔 | 线内可读正史锚点前未回收伏笔，**不能回收**正史伏笔；可埋本线伏笔 |
| 剧情线（canon_plot_lines） | 线内只读 `started_at` 可见的剧情线，不新增 / 推进 / 了结 |
| 删除线 | 线内仍有草稿或定稿时禁止删除，先删章再删线 |

---

## 文件结构

**新建**

| 路径 | 职责 |
| --- | --- |
| `src/shared/chapter-addressing.ts` | 纯函数：章号 ↔ 线 / 序号、可见性、上一章、显示名、文件名、SQL 片段 |
| `src/shared/__tests__/chapter-addressing.test.ts` | 上述纯函数测试 |
| `electron/repositories/branch-repository.ts` | `branches` 表 CRUD + 线内统计 |
| `src/services/branches/branch-service.ts` | 渲染进程：线列表缓存、`resolveVisibility / previousChapter / displayName / branchOf` |
| `src/stores/branch-store.ts` | 线列表 zustand store（UI 用） |
| `src/components/dialogs/BranchCreateDialog.tsx` | 新建 / 编辑线 |
| `src/components/panels/sidebar/BranchGroup.tsx` | 侧栏：一条线一组（章节卡 / 草稿 / 定稿） |

**修改**

| 路径 | 改动 |
| --- | --- |
| `electron/database.ts` | `branches` 表；`project_core.extra_export_mode` 列 |
| `electron/repositories/project-core-repository.ts` | `extraExportMode` 字段映射 |
| `electron/repositories/draft-repository.ts` | `getMaxFinalizedChapter()` 限正文；新增 `getMaxFinalizedInRange` |
| `electron/repositories/blueprint-repository.ts` | `count()` 限正文；新增 `countInRange`、`listInRange` |
| `electron/repositories/canon-repository.ts` | 可见性版读法 4 个 |
| `electron/repositories/summary-repository.ts` | `getSnapshotAtOrBefore(chapter)` |
| `electron/ipc-validation.ts` | `validateBranchInput`、`validateVisibility` |
| `electron/controllers/db-controller.ts` | `db:branch-*`、可见性读法、范围统计、快照通道 |
| `src/shared/ipc-channels.ts` | 上述通道类型 |
| `src/services/narrative-consistency/canon-store.ts` | 可见性版方法 |
| `src/services/narrative-consistency/context-builder.ts` | 按可见性取数、角色状态用锚点快照 |
| `src/services/workflows/commands/generate-draft.command.ts` | 首章判定、上一章、后续蓝图、要点、伏笔按线 + 注入线前提 |
| `src/services/workflows/workflow-utils.ts` | `readChapterNotesTimeline / formatOpenForeshadowings` 接受可见性 |
| `src/services/workflows/commands/finalize-chapter.command.ts` | 按线跳过写回 / 文件名 / 伏笔回收限制 / 正文定稿存角色快照 |
| `src/services/workflows/commands/directory.command.ts`、`directory-workflow.ts` | `branchId` 参数、章号映射、线前提注入 |
| `src/services/workflows/chapter-workflow.ts` | 批量生成按线范围 |
| `src/services/export-service.ts` | 正文 / 番外 / IF 分流 |
| `src/components/panels/sidebar/ProjectTree.tsx`、`ManuscriptGroup.tsx`、`DraftBoxGroup.tsx` | 按线分组、显示名 |
| `src/components/editor/ChapterCardEditor.tsx` | 「写下一章」按线 |
| `src/components/dialogs/DirectoryConfigDialog.tsx`、`BatchGenerateDialog.tsx`、`ExportDialog.tsx` | 目标线 / 导出方式 |
| `src/i18n/locales/{zh-CN,en,ru}/*.json` | 新键三语同步 |
| `vitest.config.ts` | include 新测试 |
| `CHANGELOG.md` | 一条 |

---

## 阶段划分

- **阶段 1（任务 1～5）**：地址与可见性纯函数、`branches` 表 / 仓储 / IPC、渲染进程 branch-service。无 UI，但所有后续改动的基础。
- **阶段 2（任务 6～10）**：读链路（canon、写稿、要点、伏笔）与写链路（定稿）按线隔离。做完后用 SQL 手工插一条线即可写番外并验证不污染正文。
- **阶段 3（任务 11～15）**：UI（新建线、侧栏分组、写下一章、目录生成、批量生成）与导出。
- **阶段 4（任务 16）**：收口。

---

# 阶段 1：底座

## 任务 1：章号地址与可见性纯函数（TDD）

**文件：** `src/shared/chapter-addressing.ts`、`src/shared/__tests__/chapter-addressing.test.ts`、`vitest.config.ts`

**步骤 1：** 测试

```ts
import { describe, it, expect } from 'vitest'
import {
  BRANCH_BASE, branchIdOf, localIndexOf, toChapterNumber, isMainChapter,
  visibilityFor, isVisible, previousChapterNumber, displayChapterName, chapterFileName, visibilityWhere,
  type BranchLike,
} from '../chapter-addressing'

const branches: BranchLike[] = [
  { id: 1, kind: 'extra', name: '温泉', anchorChapter: 120 },
  { id: 2, kind: 'if', name: '绫波线', anchorChapter: 80 },
  { id: 3, kind: 'extra', name: '前传', anchorChapter: 0 },
]

describe('addressing', () => {
  it('splits chapter number into branch id and local index', () => {
    expect(branchIdOf(57)).toBe(0)
    expect(branchIdOf(10003)).toBe(1)
    expect(localIndexOf(10003)).toBe(3)
    expect(toChapterNumber(2, 5)).toBe(20005)
    expect(isMainChapter(9999)).toBe(true)
    expect(isMainChapter(10000)).toBe(false)
  })
  it('rejects local index out of range', () => {
    expect(() => toChapterNumber(1, BRANCH_BASE)).toThrow()
    expect(() => toChapterNumber(1, 0)).toThrow()
  })
})

describe('visibilityFor', () => {
  it('main chapter sees main < n only', () => {
    expect(visibilityFor(57, branches)).toEqual({ mainUpTo: 56, branchId: 0, branchFrom: 0, branchUpTo: 0 })
  })
  it('branch chapter sees main <= anchor and own earlier chapters', () => {
    expect(visibilityFor(10003, branches)).toEqual({ mainUpTo: 120, branchId: 1, branchFrom: 10001, branchUpTo: 10002 })
  })
  it('first branch chapter has empty own range', () => {
    const v = visibilityFor(20001, branches)
    expect(v.branchFrom).toBe(20001)
    expect(v.branchUpTo).toBe(20000)
  })
  it('prequel with anchor 0 sees no main chapter', () => {
    expect(visibilityFor(30001, branches).mainUpTo).toBe(0)
  })
  it('throws for unknown branch', () => {
    expect(() => visibilityFor(90001, branches)).toThrow()
  })
})

describe('isVisible', () => {
  const v = visibilityFor(10003, branches)
  it.each([
    [1, true], [120, true], [121, false], [10001, true], [10002, true], [10003, false], [20001, false],
  ])('%i → %s', (n, expected) => {
    expect(isVisible(n, v)).toBe(expected)
  })
  it('compression summary (-1) is visible only to main', () => {
    expect(isVisible(-1, visibilityFor(57, branches))).toBe(true)
    expect(isVisible(-1, v)).toBe(false)
  })
})

describe('previousChapterNumber', () => {
  it('main n-1, null for chapter 1', () => {
    expect(previousChapterNumber(57, branches)).toBe(56)
    expect(previousChapterNumber(1, branches)).toBeNull()
  })
  it('first branch chapter continues from anchor; null when anchor is 0', () => {
    expect(previousChapterNumber(10001, branches)).toBe(120)
    expect(previousChapterNumber(30001, branches)).toBeNull()
  })
  it('later branch chapter continues from previous branch chapter', () => {
    expect(previousChapterNumber(10003, branches)).toBe(10002)
  })
})

describe('display and file names', () => {
  it('formats main / extra / if', () => {
    expect(displayChapterName(57, branches, '出港')).toBe('第57章 出港')
    expect(displayChapterName(10002, branches, '夜话')).toBe('番外·温泉 2 夜话')
    expect(displayChapterName(20003, branches, '')).toBe('IF·绫波线 第3章')
  })
  it('sanitizes file name', () => {
    expect(chapterFileName(10002, branches, 'a/b\\c')).toBe('番外·温泉 2 a_b_c.txt')
  })
})

describe('visibilityWhere', () => {
  it('builds a two-range predicate', () => {
    const w = visibilityWhere('chapter_number', visibilityFor(10003, branches))
    expect(w.sql).toBe('((chapter_number > 0 AND chapter_number <= ?) OR (chapter_number BETWEEN ? AND ?))')
    expect(w.params).toEqual([120, 10001, 10002])
  })
  it('main includes compression marker', () => {
    const w = visibilityWhere('chapter_number', visibilityFor(57, branches))
    expect(w.sql).toBe('(chapter_number <= ?)')
    expect(w.params).toEqual([56])
  })
})
```

**步骤 2：** `vitest.config.ts` include 加 `'src/shared/__tests__/chapter-addressing.test.ts'`，运行确认失败。

**步骤 3：** 实现

```ts
/**
 * 章号地址空间：正文 1～9999；线 id 的章 = id × 10000 + 线内序号。
 * 所有「按章号筛」的读操作都应经过 visibilityFor / isVisible / visibilityWhere。
 */
export const BRANCH_BASE = 10000
export const MAIN_MAX = BRANCH_BASE - 1

export type BranchKind = 'extra' | 'if'
export interface BranchLike { id: number; kind: BranchKind; name: string; anchorChapter: number }

export interface ChapterVisibility {
  /** 可见的正文上限（含）；0 = 看不到任何正文章 */
  mainUpTo: number
  /** 0 = 正文 */
  branchId: number
  /** 本线可见范围 [branchFrom, branchUpTo]；from > upTo 表示空 */
  branchFrom: number
  branchUpTo: number
}

export function branchIdOf(n: number): number {
  return n > 0 ? Math.floor(n / BRANCH_BASE) : 0
}
export function localIndexOf(n: number): number {
  return n > 0 ? n % BRANCH_BASE : n
}
export function toChapterNumber(branchId: number, localIndex: number): number {
  if (!Number.isInteger(localIndex) || localIndex < 1 || localIndex >= BRANCH_BASE) {
    throw new Error(`线内序号越界：${localIndex}`)
  }
  return branchId * BRANCH_BASE + localIndex
}
export function isMainChapter(n: number): boolean {
  return n > 0 && n <= MAIN_MAX
}

export function branchOf(n: number, branches: BranchLike[]): BranchLike | null {
  const id = branchIdOf(n)
  if (id === 0) return null
  const b = branches.find((x) => x.id === id)
  if (!b) throw new Error(`章号 ${n} 所属的线 ${id} 不存在`)
  return b
}

export function visibilityFor(n: number, branches: BranchLike[]): ChapterVisibility {
  const b = branchOf(n, branches)
  if (!b) return { mainUpTo: n - 1, branchId: 0, branchFrom: 0, branchUpTo: 0 }
  const base = b.id * BRANCH_BASE
  return { mainUpTo: b.anchorChapter, branchId: b.id, branchFrom: base + 1, branchUpTo: n - 1 }
}

export function isVisible(candidate: number, v: ChapterVisibility): boolean {
  if (candidate <= 0) return v.branchId === 0
  if (candidate <= MAIN_MAX) return candidate <= v.mainUpTo
  return candidate >= v.branchFrom && candidate <= v.branchUpTo
}

export function previousChapterNumber(n: number, branches: BranchLike[]): number | null {
  const b = branchOf(n, branches)
  if (!b) return n > 1 ? n - 1 : null
  if (localIndexOf(n) === 1) return b.anchorChapter > 0 ? b.anchorChapter : null
  return n - 1
}

export function displayChapterName(n: number, branches: BranchLike[], title = ''): string {
  const suffix = title ? ` ${title}` : ''
  const b = branchOf(n, branches)
  if (!b) return `第${n}章${suffix}`
  const local = localIndexOf(n)
  return b.kind === 'extra' ? `番外·${b.name} ${local}${suffix}` : `IF·${b.name} 第${local}章${suffix}`
}

export function chapterFileName(n: number, branches: BranchLike[], title = ''): string {
  const safe = title.replace(/[/\\:*?"<>|]/g, '_')
  return `${displayChapterName(n, branches, safe)}.txt`
}

export function visibilityWhere(col: string, v: ChapterVisibility): { sql: string; params: number[] } {
  if (v.branchId === 0) return { sql: `(${col} <= ?)`, params: [v.mainUpTo] }
  return {
    sql: `((${col} > 0 AND ${col} <= ?) OR (${col} BETWEEN ? AND ?))`,
    params: [v.mainUpTo, v.branchFrom, v.branchUpTo],
  }
}
```

**步骤 4：** 测试通过。

**提交：** `feat(branch): 章号地址空间与可见性纯函数`

---

## 任务 2：建表 + 仓储

**文件：** `electron/database.ts`、`electron/repositories/branch-repository.ts`、`electron/repositories/project-core-repository.ts`

**步骤 1：** `createTables` 追加：

```sql
    -- ============================================================
    -- 线：番外 / IF。章号 = id × 10000 + 线内序号；正文 1～9999
    -- ============================================================
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'extra',          -- extra / if
      anchor_kind TEXT NOT NULL DEFAULT 'chapter', -- chapter（现）/ reference_stage（预留）
      anchor_chapter INTEGER NOT NULL DEFAULT 0,   -- 番外：发生在第 N 章后；IF：从第 N 章分叉；0 = 前传
      premise TEXT DEFAULT '',                     -- 一句话前提
      setting_diff TEXT DEFAULT '',                -- 与正史的设定差异（写稿最高优先级注入）
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
```

`migrateSchema` 追加：

```ts
  addColumnIfMissing('project_core', 'extra_export_mode', `extra_export_mode TEXT DEFAULT 'appendix'`)
```

**步骤 2：** `project-core-repository.ts` 在行式接口（L36 附近）加 `extra_export_mode: string`，`ProjectCoreData`（L72 附近）加 `extraExportMode: 'appendix' | 'inline' | 'separate'`，row→data（L107 附近）加 `extraExportMode: (row.extra_export_mode as 'appendix' | 'inline' | 'separate') ?? 'appendix'`，字段映射表（L171 附近）加 `extraExportMode: 'extra_export_mode'`。

**步骤 3：** `branch-repository.ts`

```ts
import { getProjectDb } from '../database'
import { BRANCH_BASE } from '../../src/shared/chapter-addressing'
import type { BranchKind } from '../../src/shared/chapter-addressing'

export interface BranchData {
  id: number
  name: string
  kind: BranchKind
  anchorKind: 'chapter' | 'reference_stage'
  anchorChapter: number
  premise: string
  settingDiff: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}
export type BranchInput = Omit<BranchData, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }

export interface BranchStats { blueprintCount: number; draftCount: number; finalizedCount: number; maxFinalizedLocal: number }

function db() {
  const d = getProjectDb()
  if (!d) throw new Error('[BranchRepository] 数据库未连接')
  return d
}

function rowToBranch(r: Record<string, unknown>): BranchData {
  return {
    id: r.id as number,
    name: String(r.name ?? ''),
    kind: r.kind === 'if' ? 'if' : 'extra',
    anchorKind: r.anchor_kind === 'reference_stage' ? 'reference_stage' : 'chapter',
    anchorChapter: Number(r.anchor_chapter ?? 0),
    premise: String(r.premise ?? ''),
    settingDiff: String(r.setting_diff ?? ''),
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }
}

export class BranchRepository {
  static list(): BranchData[] {
    const rows = db().prepare('SELECT * FROM branches ORDER BY sort_order, id').all() as Record<string, unknown>[]
    return rows.map(rowToBranch)
  }

  static get(id: number): BranchData | null {
    const r = db().prepare('SELECT * FROM branches WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? rowToBranch(r) : null
  }

  static upsert(data: BranchInput): number {
    const d = db()
    if (data.id && data.id > 0) {
      d.prepare(`UPDATE branches SET name = ?, kind = ?, anchor_kind = ?, anchor_chapter = ?, premise = ?, setting_diff = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(data.name, data.kind, data.anchorKind, data.anchorChapter, data.premise, data.settingDiff, data.sortOrder, data.id)
      return data.id
    }
    const res = d.prepare(`INSERT INTO branches (name, kind, anchor_kind, anchor_chapter, premise, setting_diff, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data.name, data.kind, data.anchorKind, data.anchorChapter, data.premise, data.settingDiff, data.sortOrder)
    return Number(res.lastInsertRowid)
  }

  /** 线内还有章节卡 / 草稿时拒绝删除（返回 false） */
  static deleteIfEmpty(id: number): boolean {
    const s = BranchRepository.stats(id)
    if (s.blueprintCount > 0 || s.draftCount > 0) return false
    db().prepare('DELETE FROM branches WHERE id = ?').run(id)
    return true
  }

  static stats(id: number): BranchStats {
    const d = db()
    const from = id * BRANCH_BASE + 1
    const to = (id + 1) * BRANCH_BASE - 1
    const bp = d.prepare('SELECT COUNT(*) AS c FROM blueprints WHERE chapter_number BETWEEN ? AND ?').get(from, to) as { c: number }
    const dr = d.prepare('SELECT COUNT(*) AS c FROM drafts WHERE chapter_number BETWEEN ? AND ?').get(from, to) as { c: number }
    const fi = d.prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(chapter_number), 0) AS m FROM drafts WHERE status = 'finalized' AND chapter_number BETWEEN ? AND ?`).get(from, to) as { c: number; m: number }
    return { blueprintCount: bp.c, draftCount: dr.c, finalizedCount: fi.c, maxFinalizedLocal: fi.m ? fi.m % BRANCH_BASE : 0 }
  }
}
```

**步骤 4：** `draft-repository.ts`

```ts
    /** 正文已定稿最大章号（不含番外 / IF 线）；0 = 尚无定稿 */
    static getMaxFinalizedChapter(): number {
        const db = getProjectDb()
        if (!db) return 0
        const row = db.prepare(`
            SELECT MAX(chapter_number) as maxChapter
            FROM drafts
            WHERE status = 'finalized' AND chapter_number < ${BRANCH_BASE}
        `).get() as { maxChapter: number | null }
        return row?.maxChapter ?? 0
    }

    static getMaxFinalizedInRange(from: number, to: number): number {
        const db = getProjectDb()
        if (!db) return 0
        const row = db.prepare(`
            SELECT MAX(chapter_number) as maxChapter
            FROM drafts
            WHERE status = 'finalized' AND chapter_number BETWEEN ? AND ?
        `).get(from, to) as { maxChapter: number | null }
        return row?.maxChapter ?? 0
    }
```

（原方法本就返回 `number`，0 表示无定稿；`ChapterCardEditor` L98 的 `maxFinalized !== null` 判定实际等价于 `> 0`，任务 13 一并改为 `maxFinalized ? ... : 1`。）

**步骤 5：** `blueprint-repository.ts`

```ts
    /** 正文章节卡数量 */
    static count(): number {
        const db = getProjectDb()
        if (!db) return 0
        const row = db.prepare(`SELECT COUNT(*) AS c FROM blueprints WHERE chapter_number < ${BRANCH_BASE}`).get() as { c: number }
        return row.c
    }

    static countInRange(from: number, to: number): number {
        const db = getProjectDb()
        if (!db) return 0
        const row = db.prepare('SELECT COUNT(*) AS c FROM blueprints WHERE chapter_number BETWEEN ? AND ?').get(from, to) as { c: number }
        return row.c
    }
```

**步骤 6：** `summary-repository.ts` 追加：

```ts
  /** 锚点章（含）之前最近一次正文定稿时的角色状态快照 */
  static getSnapshotAtOrBefore(chapterNumber: number): { characterStates: string; chapterNumber: number } | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(
      'SELECT character_states, chapter_number FROM summary_snapshots WHERE chapter_number > 0 AND chapter_number <= ? ORDER BY chapter_number DESC, id DESC LIMIT 1'
    ).get(chapterNumber) as { character_states: string; chapter_number: number } | undefined
    return row ? { characterStates: row.character_states, chapterNumber: row.chapter_number } : null
  }
```

**步骤 7：** `canon-repository.ts` 追加可见性读法（`ChapterVisibility` 与 `visibilityWhere` 从 `../../src/shared/chapter-addressing` 引入）：

```ts
  static getTimelineVisible(v: ChapterVisibility, includeFlashback = true): TimelineEvent[] {
    const db = getProjectDb()
    if (!db) return []
    const w = visibilityWhere('chapter_number', v)
    const flash = includeFlashback ? '' : ` AND time_flow != 'flashback'`
    const rows = db.prepare(`SELECT * FROM canon_timeline_events WHERE ${w.sql}${flash} ORDER BY chapter_number, sequence`).all(...w.params) as Record<string, unknown>[]
    return rows.map(rowToTimelineEvent)
  }

  static getFactsVisible(v: ChapterVisibility): Fact[] {
    const db = getProjectDb()
    if (!db) return []
    const w = visibilityWhere('introduced_at', v)
    const rows = db.prepare(`SELECT * FROM canon_facts WHERE ${w.sql} ORDER BY introduced_at, id`).all(...w.params) as Record<string, unknown>[]
    return rows.map(rowToFact)
  }

  static getRecentSummariesVisible(v: ChapterVisibility, limit = 5): ChapterSummary[] {
    const db = getProjectDb()
    if (!db) return []
    const w = visibilityWhere('chapter_number', v)
    const rows = db.prepare(`SELECT * FROM canon_chapter_summaries WHERE ${w.sql} ORDER BY chapter_number DESC LIMIT ?`).all(...w.params, limit) as Record<string, unknown>[]
    return rows.map(rowToSummary).reverse()
  }

  /** 线内只读 started_at 可见的活跃剧情线 */
  static getActivePlotLinesVisible(v: ChapterVisibility): PlotLine[] {
    const db = getProjectDb()
    if (!db) return []
    const w = visibilityWhere('started_at', v)
    const rows = db.prepare(`SELECT * FROM canon_plot_lines WHERE status = 'active' AND ${w.sql} ORDER BY last_advanced_at DESC`).all(...w.params) as Record<string, unknown>[]
    return rows.map(rowToPlotLine)
  }
```

（行转换函数复用文件内已有的 `rowToTimeline`（L92）、`rowToPlotLine`（L123）、`rowToFact`（L137）、`rowToSummary`（L148）；上面代码里的 `rowToTimelineEvent` 写作 `rowToTimeline`，并按各自 Row 类型断言 `as TimelineRow[]` 等。）

**验证：** `pnpm exec tsc --noEmit`；打开项目无建表错误。

**提交：** `feat(branch): branches 表、仓储与按线范围的统计 / 可见性读法`

---

## 任务 3：IPC 校验 + 通道 + 控制器

**文件：** `electron/ipc-validation.ts`、`electron/__tests__/ipc-validation.test.ts`、`electron/controllers/db-controller.ts`、`src/shared/ipc-channels.ts`

**步骤 1：** 测试追加

```ts
import { validateBranchInput, validateVisibility } from '../ipc-validation'

describe('branch validation', () => {
  it('accepts extra with anchor 0 (prequel)', () => {
    const v = validateBranchInput({ name: '前传', kind: 'extra', anchorKind: 'chapter', anchorChapter: 0, premise: '', settingDiff: '', sortOrder: 0 })
    expect(v.anchorChapter).toBe(0)
  })
  it('rejects anchor beyond main range', () => {
    expect(() => validateBranchInput({ name: 'x', kind: 'if', anchorChapter: 10000 })).toThrow(ValidationError)
  })
  it('rejects unknown kind', () => {
    expect(() => validateBranchInput({ name: 'x', kind: 'side', anchorChapter: 1 })).toThrow(ValidationError)
  })
  it('validates visibility shape', () => {
    const v = validateVisibility({ mainUpTo: 120, branchId: 1, branchFrom: 10001, branchUpTo: 10002 })
    expect(v.branchFrom).toBe(10001)
    expect(() => validateVisibility({ mainUpTo: -5, branchId: 0, branchFrom: 0, branchUpTo: 0 })).toThrow(ValidationError)
  })
})
```

**步骤 2：** 实现

```ts
export function validateBranchInput(v: unknown, path = 'branch') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    id: checkOptional(v.id, `${path}.id`, (n, p) => checkNumberRange(n, p, { min: 0, max: 1e6, integer: true })),
    name: checkStringLength(v.name, `${path}.name`, { min: 1, max: 60 }),
    kind: checkEnum(v.kind ?? 'extra', `${path}.kind`, ['extra', 'if'] as const),
    anchorKind: checkEnum(v.anchorKind ?? 'chapter', `${path}.anchorKind`, ['chapter', 'reference_stage'] as const),
    anchorChapter: checkNumberRange(v.anchorChapter ?? 0, `${path}.anchorChapter`, { min: 0, max: 9999, integer: true }),
    premise: checkStringLength(v.premise ?? '', `${path}.premise`, { max: 2000 }),
    settingDiff: checkStringLength(v.settingDiff ?? '', `${path}.settingDiff`, { max: 8000 }),
    sortOrder: checkNumberRange(v.sortOrder ?? 0, `${path}.sortOrder`, { min: 0, max: 1e6, integer: true }),
  }
}

export function validateVisibility(v: unknown, path = 'visibility') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    mainUpTo: checkNumberRange(v.mainUpTo, `${path}.mainUpTo`, { min: 0, max: 9999, integer: true }),
    branchId: checkNumberRange(v.branchId, `${path}.branchId`, { min: 0, max: 1e6, integer: true }),
    branchFrom: checkNumberRange(v.branchFrom, `${path}.branchFrom`, { min: 0, max: 1e10, integer: true }),
    branchUpTo: checkNumberRange(v.branchUpTo, `${path}.branchUpTo`, { min: 0, max: 1e10, integer: true }),
  }
}
```

**步骤 3：** `db-controller.ts` 追加处理器（与 `db:setting-module-*` 相邻）：

```ts
  ipcMain.handle('db:branch-list', async () => BranchRepository.list())
  ipcMain.handle('db:branch-get', async (_e, id: number) => BranchRepository.get(id))
  ipcMain.handle('db:branch-upsert', async (_e, raw: unknown) => {
    const v = safeValidate(validateBranchInput, raw)
    if (!v.ok) return { success: false, error: v.error }
    try { return { success: true, id: BranchRepository.upsert(v.data) } } catch (e) { return { success: false, error: String(e) } }
  })
  ipcMain.handle('db:branch-delete', async (_e, id: number) => {
    try {
      const ok = BranchRepository.deleteIfEmpty(id)
      return ok ? { success: true } : { success: false, error: 'BRANCH_NOT_EMPTY' }
    } catch (e) { return { success: false, error: String(e) } }
  })
  ipcMain.handle('db:branch-stats', async (_e, id: number) => BranchRepository.stats(id))

  ipcMain.handle('db:draft-get-max-finalized-in-range', async (_e, from: number, to: number) => DraftRepository.getMaxFinalizedInRange(from, to))
  ipcMain.handle('db:blueprint-count-range', async (_e, from: number, to: number) => BlueprintRepository.countInRange(from, to))
  ipcMain.handle('db:summary-snapshot-at', async (_e, chapterNumber: number) => SummaryRepository.getSnapshotAtOrBefore(chapterNumber))

  ipcMain.handle('db:canon-timeline-get-visible', async (_e, raw: unknown, includeFlashback = true) => {
    const v = safeValidate(validateVisibility, raw)
    return v.ok ? CanonRepository.getTimelineVisible(v.data, includeFlashback) : []
  })
  ipcMain.handle('db:canon-fact-list-visible', async (_e, raw: unknown) => {
    const v = safeValidate(validateVisibility, raw)
    return v.ok ? CanonRepository.getFactsVisible(v.data) : []
  })
  ipcMain.handle('db:canon-summary-list-visible', async (_e, raw: unknown, limit = 5) => {
    const v = safeValidate(validateVisibility, raw)
    return v.ok ? CanonRepository.getRecentSummariesVisible(v.data, limit) : []
  })
  ipcMain.handle('db:canon-plot-list-visible', async (_e, raw: unknown) => {
    const v = safeValidate(validateVisibility, raw)
    return v.ok ? CanonRepository.getActivePlotLinesVisible(v.data) : []
  })
```

**步骤 4：** `ipc-channels.ts` 追加类型（顶部 `import type { BranchData, BranchInput, BranchStats } from '../../electron/repositories/branch-repository'`、`import type { ChapterVisibility } from './chapter-addressing'`）：

```ts
  // ===== 线（番外 / IF） =====
  'db:branch-list': { args: []; return: BranchData[] }
  'db:branch-get': { args: [id: number]; return: BranchData | null }
  'db:branch-upsert': { args: [data: BranchInput]; return: { success: boolean; id?: number; error?: string } }
  'db:branch-delete': { args: [id: number]; return: { success: boolean; error?: string } }
  'db:branch-stats': { args: [id: number]; return: BranchStats }
  'db:draft-get-max-finalized-in-range': { args: [from: number, to: number]; return: number }
  'db:blueprint-count-range': { args: [from: number, to: number]; return: number }
  'db:summary-snapshot-at': { args: [chapterNumber: number]; return: { characterStates: string; chapterNumber: number } | null }
  'db:canon-timeline-get-visible': { args: [v: ChapterVisibility, includeFlashback?: boolean]; return: TimelineEvent[] }
  'db:canon-fact-list-visible': { args: [v: ChapterVisibility]; return: Fact[] }
  'db:canon-summary-list-visible': { args: [v: ChapterVisibility, limit?: number]; return: ChapterSummary[] }
  'db:canon-plot-list-visible': { args: [v: ChapterVisibility]; return: PlotLine[] }
```

**验证：** `pnpm exec vitest run electron/__tests__/ipc-validation.test.ts`；`pnpm exec tsc --noEmit`。

**提交：** `feat(branch): 线与可见性读法的 IPC 通道`

---

## 任务 4：渲染进程 branch-service + store

**文件：** `src/services/branches/branch-service.ts`、`src/stores/branch-store.ts`

**步骤 1：** `branch-service.ts`（供工作流命令使用，不依赖 React）

```ts
import { ipc } from '../ipc-client'
import { globalEventBus } from '../../shared/event-bus'
import {
  visibilityFor, previousChapterNumber, displayChapterName, chapterFileName, branchOf, isMainChapter,
  type ChapterVisibility, type BranchLike,
} from '../../shared/chapter-addressing'
import type { BranchData } from '../../../electron/repositories/branch-repository'

let cache: BranchData[] | null = null

globalEventBus.on('REFRESH_RESOURCE', ({ resources }) => {
  if (resources.includes('branches')) cache = null
})

export function invalidateBranchCache(): void { cache = null }

export async function getBranches(): Promise<BranchData[]> {
  if (cache) return cache
  cache = await ipc.invoke('db:branch-list').catch(() => [] as BranchData[])
  return cache
}

export async function resolveVisibility(chapterNumber: number): Promise<ChapterVisibility> {
  if (isMainChapter(chapterNumber)) return visibilityFor(chapterNumber, [])
  return visibilityFor(chapterNumber, await getBranches())
}

export async function resolveBranch(chapterNumber: number): Promise<BranchData | null> {
  if (isMainChapter(chapterNumber)) return null
  return branchOf(chapterNumber, await getBranches()) as BranchData | null
}

export async function resolvePreviousChapter(chapterNumber: number): Promise<number | null> {
  return previousChapterNumber(chapterNumber, isMainChapter(chapterNumber) ? [] : await getBranches())
}

export async function resolveDisplayName(chapterNumber: number, title = ''): Promise<string> {
  return displayChapterName(chapterNumber, isMainChapter(chapterNumber) ? [] : await getBranches(), title)
}

export async function resolveFileName(chapterNumber: number, title = ''): Promise<string> {
  return chapterFileName(chapterNumber, isMainChapter(chapterNumber) ? [] : await getBranches(), title)
}

/** 线前提 + 设定差异，写稿 / 目录生成时拼进全局指导（正文返回空串） */
export function branchGuidanceBlock(b: BranchLike & { premise: string; settingDiff: string } | null): string {
  if (!b) return ''
  const head = b.kind === 'extra'
    ? `【本线为番外「${b.name}」，发生在${b.anchorChapter > 0 ? `正文第 ${b.anchorChapter} 章之后` : '正文开始之前'}；不得改变正史既定事实】`
    : `【本线为 IF 线「${b.name}」，自正文第 ${b.anchorChapter} 章分叉；分叉后的走向以本线为准】`
  return [head, b.premise ? `前提：${b.premise}` : '', b.settingDiff ? `与正史的设定差异（优先级高于角色事实）：\n${b.settingDiff}` : '']
    .filter(Boolean).join('\n')
}
```

`EventPayloadMap['REFRESH_RESOURCE']['resources']` 的联合类型加 `'branches'`（在 `src/shared/event-bus.ts`）。

**步骤 2：** `branch-store.ts`

```ts
import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { invalidateBranchCache } from '../services/branches/branch-service'
import { globalEventBus } from '../shared/event-bus'
import type { BranchData, BranchInput } from '../../electron/repositories/branch-repository'

interface BranchState {
  branches: BranchData[]
  load: () => Promise<void>
  save: (data: BranchInput) => Promise<{ success: boolean; id?: number; error?: string }>
  remove: (id: number) => Promise<{ success: boolean; error?: string }>
}

export const useBranchStore = create<BranchState>((set, get) => ({
  branches: [],
  load: async () => {
    set({ branches: await ipc.invoke('db:branch-list') })
  },
  save: async (data) => {
    const res = await ipc.invoke('db:branch-upsert', data)
    if (res.success) {
      invalidateBranchCache()
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['branches'] })
      await get().load()
    }
    return res
  },
  remove: async (id) => {
    const res = await ipc.invoke('db:branch-delete', id)
    if (res.success) {
      invalidateBranchCache()
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['branches'] })
      await get().load()
    }
    return res
  },
}))
```

项目切换时（`project-store` 打开 / 关闭项目处）调用 `invalidateBranchCache()` 与 `useBranchStore.getState().load()`。

**验证：** `pnpm exec tsc --noEmit`。

**提交：** `feat(branch): 渲染进程线服务与 store`

---

## 任务 5：canonStore 可见性方法

**文件：** `src/services/narrative-consistency/canon-store.ts`

**步骤 1：** 在 `CanonStore` 类中追加（沿用文件内 try/catch 返回安全默认值的写法）：

```ts
  async getTimelineVisible(v: ChapterVisibility, includeFlashback = true): Promise<TimelineEvent[]> {
    try { return await ipc.invoke('db:canon-timeline-get-visible', v, includeFlashback) } catch { return [] }
  }
  async getFactsVisible(v: ChapterVisibility): Promise<Fact[]> {
    try { return await ipc.invoke('db:canon-fact-list-visible', v) } catch { return [] }
  }
  async getRecentSummariesVisible(v: ChapterVisibility, limit = 5): Promise<ChapterSummary[]> {
    try { return await ipc.invoke('db:canon-summary-list-visible', v, limit) } catch { return [] }
  }
  async getActivePlotLinesVisible(v: ChapterVisibility): Promise<PlotLine[]> {
    try { return await ipc.invoke('db:canon-plot-list-visible', v) } catch { return [] }
  }
```

**验证：** `pnpm exec tsc --noEmit`。

**提交：** `feat(branch): canonStore 可见性读法`

---

# 阶段 2：读写链路按线隔离

## 任务 6：`buildCanonContext` 按可见性取数

**文件：** `src/services/narrative-consistency/context-builder.ts`

**步骤 1：** 替换 L198–204 的并行读取为：

```ts
  const { resolveVisibility, resolveBranch } = await import('../branches/branch-service')
  const visibility = await resolveVisibility(params.chapterNumber)
  const branch = await resolveBranch(params.chapterNumber)

  const [timeline, summaries, plotLines, facts, canonCharStates] = await Promise.all([
    canonStore.getTimelineVisible(visibility),
    canonStore.getRecentSummariesVisible(visibility, recentSummaryCount),
    canonStore.getActivePlotLinesVisible(visibility),
    canonStore.getFactsVisible(visibility),
    branch ? Promise.resolve([] as CharacterStateSnapshot[]) : canonStore.getAllCharacterStates(),
  ])

  // 线内角色状态：取锚点章定稿时的角色卡快照；无快照（老项目）退回当前角色卡并记入 meta
  let characterInputs = params.characters
  let snapshotChapter: number | null = null
  if (branch) {
    const snap = await ipc.invoke('db:summary-snapshot-at', branch.anchorChapter).catch(() => null)
    if (snap?.characterStates) {
      try {
        const parsed = JSON.parse(snap.characterStates) as Array<{ name: string; role: string; currentState?: unknown }>
        if (Array.isArray(parsed) && parsed.length > 0) {
          characterInputs = parsed as typeof params.characters
          snapshotChapter = snap.chapterNumber
        }
      } catch { /* 快照损坏时退回当前角色卡 */ }
    }
  }
  const mergedStates = mergeCharacterStates(canonCharStates, characterInputs)
```

`meta` 加两个字段：`visibility`、`characterSnapshotChapter: snapshotChapter`（`CanonContext['meta']` 类型同步在 `types.ts` 补充为可选字段）。文件顶部补 `import { ipc } from '../ipc-client'`。

**步骤 2：** 正文路径行为不变：`visibilityFor(n, [])` 得到 `mainUpTo = n-1`，`getTimelineVisible` 等价于原 `getTimeline(n-1)`；`getFactsVisible` 对正文是 `introduced_at <= n-1`，比原「全量」略严——这是修正（写第 N 章不应看到未来章的事实）；`getRecentSummariesVisible` 对正文含 `-1` 压缩摘要。

**验证：** `pnpm exec vitest run src/services/narrative-consistency/__tests__/narrative-consistency.test.ts`（若测试直接 mock `canonStore.getTimeline`，把 mock 改成 `getTimelineVisible` 等四个方法）。

**提交：** `feat(branch): Canon 上下文按线可见性取数，线内角色状态用锚点快照`

---

## 任务 7：写稿命令按线

**文件：** `src/services/workflows/commands/generate-draft.command.ts`、`src/services/workflows/workflow-utils.ts`

**步骤 1：** `workflow-utils.ts` 的 `readChapterNotesTimeline` 改签名与筛选：

```ts
export async function readChapterNotesTimeline(
  currentChapter: number,
  fullWindow = 5,
  maxChars = 3000,
): Promise<string> {
  try {
    const { resolveVisibility, getBranches } = await import('./../branches/branch-service')
    const { isVisible, displayChapterName, isMainChapter } = await import('../../shared/chapter-addressing')
    const visibility = await resolveVisibility(currentChapter)
    const branches = isMainChapter(currentChapter) ? [] : await getBranches()
    const all = await ipc.invoke('db:blueprint-get-all')
    const visible = (all || [])
      .filter((b) => isVisible(b.chapterNumber, visibility))
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
    const recentCut = visible.length - fullWindow
    const lines = visible.map((bp, idx) => {
      const label = `【${displayChapterName(bp.chapterNumber, branches, bp.title || '')}】`
      return idx >= recentCut && bp.notes?.trim() ? `${label}\n${bp.notes.trim()}` : label
    })
    let result = lines.join('\n\n')
    if (result.length > maxChars) result = result.slice(-maxChars)
    return result || '（无章节要点）'
  } catch {
    return '（章节要点读取失败）'
  }
}
```

（相对路径按文件实际位置调整：`workflow-utils.ts` 在 `src/services/workflows/`，branch-service 在 `src/services/branches/`，即 `'../branches/branch-service'`。）

`formatOpenForeshadowings` 加第四个参数并在开头过滤：

```ts
export function formatOpenForeshadowings(
  open: OpenForeshadowing[] | null | undefined,
  currentChapter: number,
  maxItems = 12,
  visibility?: ChapterVisibility,
): string {
  const pool = (open ?? []).filter((f) => !visibility || isVisible(f.plantedChapter, visibility))
  if (pool.length === 0) return '（暂无未回收伏笔）'
  // 下面原逻辑中的 open 全部替换为 pool
```

**步骤 2：** `generate-draft.command.ts`

- L53–63 后续蓝图：

```ts
      const { branchIdOf } = await import('../../../shared/chapter-addressing')
      const me = this.chapterInfo.chapterNumber
      const futureBlueprintsArr = allBlueprints.filter(
        b => branchIdOf(b.chapterNumber) === branchIdOf(me) && b.chapterNumber > me && b.chapterNumber <= me + 5
      )
```

- L48 全局指导拼接线前提：

```ts
    const { resolveBranch, resolvePreviousChapter, branchGuidanceBlock } = await import('../../branches/branch-service')
    const branch = await resolveBranch(this.chapterInfo.chapterNumber)
    const previousChapter = await resolvePreviousChapter(this.chapterInfo.chapterNumber)
    const mergedGuidance = [branchGuidanceBlock(branch), project.novelConfig.globalGuidance || '', projectPrompts].filter(Boolean).join('\n\n')
```

- L99 首章判定：`const isFirstChapter = previousChapter === null`
- L150–151 上一章结尾：

```ts
      const recentContents = await this.readRecentFinalizedContents(this.chapterInfo.chapterNumber, 3)
      const previousEnding = previousChapter !== null
        ? stripEditorialMarkers(recentContents.get(previousChapter) || '').slice(-1000)
        : ''
```

- `readRecentFinalizedContents` 改为沿「上一章链」回溯：

```ts
  private async readRecentFinalizedContents(currentChapter: number, windowSize: number): Promise<Map<number, string>> {
    const { resolvePreviousChapter } = await import('../../branches/branch-service')
    const nums: number[] = []
    let cursor: number | null = currentChapter
    while (nums.length < windowSize) {
      cursor = await resolvePreviousChapter(cursor)
      if (cursor === null) break
      nums.push(cursor)
    }
    const result = new Map<number, string>()
    await Promise.all(nums.map(async (n) => {
      try {
        const meta = await ipc.invoke('db:draft-get-finalized', n)
        if (!meta) return
        const full = await ipc.invoke('db:draft-get-full', meta.id)
        const content = full?.content?.trim()
        if (content) result.set(n, content)
      } catch { /* 忽略单章读取失败 */ }
    }))
    return result
  }
```

（番外第 1 章的「上一章」= 锚点正文章，因此反雷同与结尾接续会拿到第 A 章正文，符合「发生在第 A 章后」的语义。）

- `buildForeshadowingContext`：

```ts
  private async buildForeshadowingContext(currentChapter: number): Promise<string> {
    try {
      const { formatOpenForeshadowings } = await import('../workflow-utils')
      const { resolveVisibility } = await import('../../branches/branch-service')
      const open = await ipc.invoke('db:foreshadow-get-open')
      return formatOpenForeshadowings(open, currentChapter, 12, await resolveVisibility(currentChapter))
    } catch {
      return '（暂无未回收伏笔）'
    }
  }
```

**步骤 3：** 日志里凡打印 `第${n}章` 的位置，改用 `await resolveDisplayName(n, title)`（至少 `generateDraft.*` 与 workflow 标题两处）。

**验证：** `pnpm exec tsc --noEmit`；手工：SQL 插入 `branches(name='温泉',kind='extra',anchor_chapter=3)`，插入 `blueprints(chapter_number=10001,...)`，对 10001 写稿，日志显示「番外·温泉 1」、上一章结尾取自第 3 章、后续蓝图为空、Canon 时间线只含 ≤3 章。

**提交：** `feat(branch): 写稿上下文按线可见性组装，注入线前提`

---

## 任务 8：定稿按线写回

**文件：** `src/services/workflows/commands/finalize-chapter.command.ts`、`src/services/narrative-consistency/fact-extractor.ts`

**步骤 1：** 构建后处理步骤的函数开头（L95 前）获取线信息，并把 `isBranch` 传入各步骤：

```ts
  const { isMainChapter } = await import('../../../shared/chapter-addressing')
  const isBranch = !isMainChapter(chapterNumber)
```

（若该函数是同步的，改为在调用方先算好 `isBranch` 作为参数传入。）

**步骤 2：** 各步骤规则

| 步骤 | 正文 | 线 |
| --- | --- | --- |
| `kb_import` | 不变 | **不推入 steps** |
| `chapter_notes` | 不变 | 不变（章号在线段内，摘要自隔离） |
| `canon_writeback` | 不变 | `extractAndWriteback(..., { branchMode: true })` → 只写 timeline / facts |
| `canon_compression` | 不变 | 不推入（条件改 `!isBranch && chapterNumber % 5 === 0`） |
| `character_cards` | 不变，并**追加**存快照 | 不推入 |
| `foreshadow_track` | 不变 | 只回收 `branchIdOf(plantedChapter) === branchIdOf(chapterNumber)` 的伏笔 |

`fact-extractor.ts`：

```ts
export async function extractAndWriteback(params: ExtractParams, opts?: { branchMode?: boolean }): Promise<{ ok: boolean; errors: string[] }> {
  try {
    const payload = extractCanonWriteback(params)
    if (opts?.branchMode) {
      payload.characterDeltas = []
      payload.plotLineChanges = undefined
    }
    return await canonStore.writeback(payload)
  } catch (err) {
    return { ok: false, errors: [String(err)] }
  }
}
```

`foreshadow_track` 回收循环：

```ts
        const { branchIdOf } = await import('../../../shared/chapter-addressing')
        const myBranch = branchIdOf(chapterNumber)
        const openById = new Map(openSlim.map((f) => [f.id, f]))
        for (const id of result.paidIds) {
          const f = openById.get(id)
          if (!f) continue
          if (branchIdOf(f.plantedChapter) !== myBranch) {
            callbacks.log(`  ↪ 伏笔 #${id} 属于另一条线，本线不可回收，跳过`)
            continue
          }
          await ipc.invoke('db:foreshadow-mark-paid', id, chapterNumber)
          paidCount++
        }
```

`character_cards` 步骤末尾（正文）追加：

```ts
        const refreshed = await ipc.invoke('db:character-get-all').catch(() => [])
        const snapshot = refreshed.map((c) => ({ name: c.name, role: c.role, currentState: c.currentState }))
        await ipc.invoke('db:save-summary-snapshot', chapterNumber, JSON.stringify(snapshot))
        callbacks.log(`  📸 已保存第 ${chapterNumber} 章角色状态快照（供番外 / IF 线读取）`)
```

**步骤 3：** 投影文件名（L482–487）：

```ts
    const { resolveFileName, resolveDisplayName } = await import('../../branches/branch-service')
    const fileName = await resolveFileName(this.params.chapterNumber, this.params.chapterInfo.title || '')
    const physicalPath = `${project.path}/${fileName}`
    const heading = await resolveDisplayName(this.params.chapterNumber, this.params.chapterInfo.title || '')
    const contentToWrite = `${heading}\n\n` + gatedContent.replace(/^#+ .*\n*/, '')
```

**步骤 4：** 定稿 Gate（L430）无需改：`buildCanonContext` 已按线取数。

**验证：** 对任务 7 的 10001 章定稿：知识库文档数不变；`canon_character_state` 不变；`canon_timeline_events` 新增行 `chapter_number = 10001`；`summary_snapshots` 无新行；根目录生成 `番外·温泉 1 标题.txt`。再对正文第 4 章定稿：`summary_snapshots` 新增 `chapter_number = 4`。

**提交：** `feat(branch): 定稿按线跳过角色卡 / 剧情线 / 知识库写回，正文定稿保存角色快照`

---

## 任务 9：目录生成 / 批量生成按线

**文件：** `src/services/workflows/commands/directory.command.ts`、`src/services/workflows/directory-workflow.ts`、`src/services/workflows/chapter-workflow.ts`

**步骤 1：** `directory.command.ts` 参数加 `branchId?: number`（0 / undefined = 正文）。L24–30 的起点计算：

```ts
    const { toChapterNumber, BRANCH_BASE, branchIdOf } = await import('../../../shared/chapter-addressing')
    const branchId = this.params.branchId ?? 0
    const inMyBranch = existingBlueprints.filter((b) => branchIdOf(b.chapterNumber) === branchId)
    const localStart = this.params.startChapter || (inMyBranch.length + 1)
    const startChapter = branchId === 0 ? localStart : toChapterNumber(branchId, localStart)
```

后续 `endChapter / cursor` 用同一地址空间（线内连续，且 `endChapter < (branchId + 1) * BRANCH_BASE`）。送给模型的 `withN / withM` 用**线内序号**（`localIndexOf`），返回的蓝图 `chapterNumber` 写库前再 `toChapterNumber(branchId, local)`。

L71 / L85 的 `withGlobalGuidance(globalGuidance)`：

```ts
    const { resolveBranch, branchGuidanceBlock } = await import('../../branches/branch-service')
    const branch = branchId ? await ipc.invoke('db:branch-get', branchId) : null
    const guidanceWithBranch = [branchGuidanceBlock(branch), globalGuidance].filter(Boolean).join('\n\n')
```

`withChapterList(chapterList)` 只列本线已有蓝图；线内第一批时把锚点章前 5 章正文的 `notes` 作为「上文」拼进 `chapterList` 前面（锚点 0 则无）。

**步骤 2：** `directory-workflow.ts` 的 `createDirectoryWorkflow(params)` 透传 `branchId`；`loadDirectoryBlueprints()` 不变（全量），调用方自行按线过滤。

**步骤 3：** `chapter-workflow.ts` `createBatchGenerateWorkflow`：`startChapter / endChapter` 已是绝对章号，UI 侧负责传线内映射后的值；只把步骤名 `第${n}章` 改为 `displayChapterName(n, params.branches ?? [], '')`——参数加 `branches?: BranchLike[]`，由对话框传入。

**验证：** 对线 1 生成 5 章目录 → `blueprints` 出现 10001～10005；正文目录追加不受影响（`count()` 只算正文）。

**提交：** `feat(branch): 目录与批量生成支持目标线`

---

## 任务 10：导出分流

**文件：** `src/services/export-service.ts`、`src/components/dialogs/ExportDialog.tsx`

**步骤 1：** `ExportOptions` 加 `extraMode?: 'appendix' | 'inline' | 'separate'`（缺省读 `project_core.extraExportMode`）与 `includeIf?: boolean`（默认 true）。

**步骤 2：** 收集阶段按线分桶：

```ts
    const branches = await ipc.invoke('db:branch-list')
    const { branchIdOf, branchOf, displayChapterName } = await import('../shared/chapter-addressing')
    const main = chapterContents.filter((c) => branchIdOf(c.chapterNumber) === 0)
    const extras = chapterContents.filter((c) => branchOf(c.chapterNumber, branches)?.kind === 'extra')
    const ifs = chapterContents.filter((c) => branchOf(c.chapterNumber, branches)?.kind === 'if')
```

`title` 统一用 `displayChapterName(n, branches, bp.title)`。

组装规则：
- `inline`：把每条番外按 `anchorChapter` 插到对应正文章之后（锚点 0 插在最前）；同锚点多条按 `sort_order`
- `appendix`：正文后追加一节「番外」，内部按锚点章、线序、线内序排序
- `separate`：正文一个文件；每条番外线一个文件 `书名·番外·线名.<ext>`
- IF：每条线一个文件 `书名·IF·线名.<ext>`；`includeIf=false` 则跳过

md / txt / epub 三种格式沿用现有拼接函数，只是多调几次。

**步骤 3：** `ExportDialog.tsx` 加「番外位置」三选一（默认项目配置）与「包含 IF 线」开关；项目配置在 `NovelConfigEditor` 里加一个下拉写回 `project_core.extraExportMode`（`db:project-core-update`）。

**验证：** 有 1 条番外 + 1 条 IF 的项目导出 txt：`appendix` 得到 1 个正文文件（末尾有「番外」节）+ 1 个 IF 文件；`separate` 得到 3 个文件。

**提交：** `feat(branch): 导出按正文 / 番外 / IF 分流，番外位置可配置`

---

# 阶段 3：UI

## 任务 11：新建 / 编辑线对话框

**文件：** `src/components/dialogs/BranchCreateDialog.tsx`、i18n `dialogs.json`

**步骤 1：** 表单：名称、类型（番外 / IF）、锚点章（数字输入，0～正文最大章节卡号；显示锚点章标题；0 显示「前传：不读任何正文」）、前提（多行）、设定差异（多行，仅 IF 默认展开）。保存走 `useBranchStore.save`。编辑模式下类型与锚点可改，但线内已有定稿时锚点输入禁用并提示。

```tsx
const maxMain = useMemo(() => Math.max(0, ...blueprints.filter((b) => isMainChapter(b.chapterNumber)).map((b) => b.chapterNumber)), [blueprints])
const anchorTitle = blueprints.find((b) => b.chapterNumber === anchor)?.title ?? ''
const onSave = async () => {
  const res = await save({ id: editing?.id, name: name.trim(), kind, anchorKind: 'chapter', anchorChapter: anchor, premise, settingDiff, sortOrder: editing?.sortOrder ?? branches.length })
  if (res.success) onClose()
  else setError(res.error ?? '')
}
```

**步骤 2：** i18n `dialogs.json` 三语加 `branch.{createTitle,editTitle,name,kind,kindExtra,kindIf,anchor,anchorPrequel,anchorHint,premise,premisePlaceholder,settingDiff,settingDiffPlaceholder,anchorLockedHint,save,cancel}`。

**验证：** 新建后 `branches` 有行，`useBranchStore.branches` 更新。

**提交：** `feat(branch): 新建 / 编辑线对话框`

---

## 任务 12：侧栏按线分组

**文件：** `src/components/panels/sidebar/ProjectTree.tsx`、`ManuscriptGroup.tsx`、`DraftBoxGroup.tsx`、`BranchGroup.tsx`、i18n `panels.json`

**步骤 1：** `ProjectTree.tsx` L134–143 只保留正文：

```tsx
  const branches = useBranchStore((s) => s.branches)
  const finalizedAll = Object.values(draftsByChapter).map((ds) => ds.find((d) => d.status === 'finalized')).filter(Boolean) as DraftMeta[]
  const manuscriptFiles = finalizedAll
    .filter((d) => isMainChapter(d.chapterNumber))
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .map(toPseudoFile)
  const mainDrafts = Object.fromEntries(Object.entries(draftsByChapter).filter(([n]) => isMainChapter(Number(n))))
```

在 `ManuscriptGroup` 之后渲染：

```tsx
      <BranchGroup branches={branches} draftsByChapter={draftsByChapter} finalized={finalizedAll} onCreate={() => setBranchDialogOpen(true)} />
```

**步骤 2：** `BranchGroup.tsx`：标题行「番外 / IF 线」+ 「+」按钮；每条线一个可折叠子组：标题 `番外·温泉（第 120 章后）` / `IF·绫波线（第 80 章分叉）`，右侧「编辑」「删除」（删除失败 `BRANCH_NOT_EMPTY` 时 toast「先删除线内章节」）；子组内复用 `DraftBoxGroup` 与 `ManuscriptGroup` 渲染该线范围的草稿与定稿，并传 `branches` 供显示名。

**步骤 3：** `ManuscriptGroup.tsx` L79–80 与 `DraftBoxGroup.tsx` 的标题格式化改为 `displayChapterName(chapterNumber, branches, title)`（两组件新增可选 prop `branches: BranchLike[]`，正文传 `[]`）。

**步骤 4：** i18n `panels.json` 三语加 `branch.{groupTitle,create,edit,delete,notEmpty,anchorAfter,forkAt,prequel}`。

**验证：** 正文组不出现 10001+ 章；线组内显示「番外·温泉 1 夜话」。

**提交：** `feat(branch): 侧栏按线分组显示章节卡 / 草稿 / 定稿`

---

## 任务 13：章节卡「写下一章」按线

**文件：** `src/components/editor/ChapterCardEditor.tsx`

**步骤 1：** L97–98：

```ts
      const { branchIdOf, BRANCH_BASE, isMainChapter } = await import('../../shared/chapter-addressing')
      const me = blueprint.chapterNumber
      if (isMainChapter(me)) {
        const maxFinalized = await ipc.invoke('db:draft-get-max-finalized-chapter')
        setNextWriteChapter(maxFinalized ? maxFinalized + 1 : 1)
      } else {
        const id = branchIdOf(me)
        const maxInBranch = await ipc.invoke('db:draft-get-max-finalized-in-range', id * BRANCH_BASE + 1, (id + 1) * BRANCH_BASE - 1)
        setNextWriteChapter(maxInBranch ? maxInBranch + 1 : id * BRANCH_BASE + 1)
      }
```

L199 「新建章节卡」的 `maxNum + 1` 同样限定在当前线范围内取 max。标题栏与按钮文案用 `displayChapterName`。

**验证：** 在线内章节卡上「写下一章」得到 10002，不是正文 max+1。

**提交：** `feat(branch): 章节卡的下一章按所属线计算`

---

## 任务 14：目录生成 / 批量生成对话框加「目标线」

**文件：** `src/components/dialogs/DirectoryConfigDialog.tsx`、`BatchGenerateDialog.tsx`、i18n `dialogs.json`

**步骤 1：** `DirectoryConfigDialog` 加 prop `defaultBranchId?: number`，内部 `<select>` 列「正文」+ 全部线；`existingCount` 改为内部按所选线用 `db:blueprint-count-range`（正文用 `db:blueprint-count`）查询；`onConfirm(params)` 的 `params` 加 `branchId`。范围输入框的数字是**线内序号**。

**步骤 2：** `BatchGenerateDialog` 同样加目标线；`startChapter / endChapter` 输入线内序号，提交时 `toChapterNumber(branchId, n)`；传 `branches` 给 `createBatchGenerateWorkflow` 用于步骤名。

**步骤 3：** i18n 三语加 `directoryConfig.targetBranch`、`directoryConfig.mainLine`、`batchGenerate.targetBranch`。

**验证：** 选线 1、范围 1～3 → 生成 10001～10003；批量写 1～2 → 工作流步骤名「番外·温泉 1」「番外·温泉 2」。

**提交：** `feat(branch): 目录 / 批量生成对话框支持目标线`

---

## 任务 15：伏笔台账与角色面板的显示名

**文件：** 伏笔侧栏（`sidebarView === 'foreshadowing'` 对应组件）、角色卡「最近更新章」显示处

**步骤 1：** 凡显示 `第{{n}}章` 的地方，通过 `useBranchStore` 拿 `branches` 后用 `displayChapterName(n, branches)`；伏笔列表给线内伏笔加一个与 `KbKindBadge` 同风格的小徽标（线名）。

**验证：** 线内埋的伏笔在台账中显示「番外·温泉 1 埋下」。

**提交：** `feat(branch): 伏笔与角色面板按线显示章名`

---

# 阶段 4：收口

## 任务 16：CHANGELOG + 全量验证 + 设计说明

**文件：** `CHANGELOG.md`、`docs/design/05-story-branches.md`（新建，≤ 100 行：地址空间、可见性规则表、定稿写回表、导出规则）

**步骤 1：** `CHANGELOG.md`：

```
### 新增
- 番外 / IF 线：书内可创建多条线，各自有章节卡、草稿与定稿。写作时只读「正史到锚点 + 本线」；定稿只写本线的时间线 / 事实 / 摘要，不改角色卡、剧情线与知识库。支持前传（锚点 0）、线内目录与批量生成、伏笔按线隔离；导出时番外位置可配置（附录 / 插入锚点后 / 单独文件），IF 线单独成文。
### 修正
- 写第 N 章时事实条目只读引入章 ≤ N-1 的记录，不再读到未来章。
```

**步骤 2：**

```
pnpm exec tsc --noEmit
pnpm exec vitest run
```

预期：0 类型错误；`chapter-addressing.test.ts`、`ipc-validation.test.ts` 新用例、i18n 三语一致全部通过。

**步骤 3：** 手工回归：正文写稿 / 定稿 / 导出与改前一致（正文路径只多了「事实 ≤ N-1」这一处收紧）。

**提交：** `docs(branch): 番外 / IF 线设计说明与 CHANGELOG`

---

## 自检

**规格覆盖度**

| 需求 | 任务 |
| --- | --- |
| 番外 / IF 两种线、锚点、前提、设定差异 | 2、4、11 |
| 前传锚点 0 | 1（`mainUpTo = 0`、`previousChapterNumber → null`）、11 |
| 读：正史 ≤ 锚点 + 本线更早章 | 1、6、7 |
| 角色状态取锚点快照，角色卡永远正史 | 6（读）、8（正文定稿存快照、线不写角色卡） |
| 伏笔可读不可回收、可埋本线 | 7（读）、8（回收限制） |
| 剧情线只读 | 2、6、8 |
| 番外 / IF 定稿不进知识库 | 8 |
| 一致性校验按可见集合 | 6（Gate 与写稿共用 `buildCanonContext`） |
| 内部章号高位段、显示名、文件名 | 1、8、12、13、15 |
| 章节树三组、下一章按线、目录 / 批量按线 | 9、12、13、14 |
| 导出：默认附录、可配置、IF 单独文件 | 2（列）、10 |
| 与参考作品用法 B 的衔接 | 2（`anchor_kind` 预留） |
| 删除线保护 | 2、12 |

**占位符扫描**：无「待定 / TODO」。任务 9 步骤 1 中「锚点前 5 章 notes 拼进 chapterList」给出的是规则而非代码块——实现时从 `db:blueprint-get-all` 过滤 `isMainChapter && chapterNumber <= anchor` 取最后 5 条的 `title + notes` 用现有 `chapterList` 相同格式拼接。

**类型一致性**：`ChapterVisibility` 字段名 `mainUpTo / branchId / branchFrom / branchUpTo` 在任务 1、3、5、6 一致；`BranchData.kind` 复用 `BranchKind`；IPC `db:branch-upsert` 返回 `{ success, id }`（与 `db:setting-module-upsert` 同形），store 按 `res.success` 读取；`displayChapterName(n, branches, title)` 三参顺序在 7、8、10、12、13 一致。

**已知取舍**

- 剧情线的 `status` 变化不按章号记录，线内只能按 `started_at` 过滤，可能读到锚点之后才了结的线仍显示 active；影响很小，记录在设计说明。
- 老项目锚点之前没有角色快照时退回当前角色卡，并在 Canon meta 里标注 `characterSnapshotChapter = null`，日志提示一次。
- 单条线上限 9999 章、线数量上限受 `chapter_number` 整数范围限制（≥ 200000 条线），实际无感。
