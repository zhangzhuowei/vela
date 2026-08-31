# 对话创作模式（双管线并存）规格

日期：2026-08-31

## 一句话

在 Vela 现有「蓝图 → 写稿 → 草稿箱 → 定稿」管线之外，加一条按章可选的「对话控场 → 收场蒸馏 → 汇稿」循环；两条线在草稿箱汇合，定稿与后处理（canon 结算、角色状态、伏笔）完全复用。

## 模式开关

- `project_core.creation_mode TEXT DEFAULT 'pipeline'`：工程默认（`pipeline` | `dialogue`）
- `blueprints.creation_mode TEXT DEFAULT ''`：章级覆盖，空串表示继承工程默认
- 小说配置页加「创作模式」选择器；章节蓝图卡上可对单章切换

## 对话循环（dialogue 模式的一章）

1. 章下建「场」（scene），带场目标
2. 场内对话：用户输入是**控场指令**（不是扮演角色）；模型输出场景叙事正文，正文后附 `<state>{...}</state>` 角色状态补丁（只含变化字段）
3. 状态补丁合并进**章级进行中状态**（`blueprints.working_state`，开章时从 canon 角色状态拷出）
4. 收场：把该场全部对话蒸馏成小说正文 → 预览可手改 → 落盘到场（`scenes.body`，`status='distilled'`）
5. 汇稿：把本章所有已收场正文按场序拼接，`db:draft-create` 写入草稿箱成为新版本
6. 之后走 Vela 原生流程：草稿箱可继续重写/精修，**定稿**触发原有后处理管线（canon 写回、角色卡状态更新、伏笔追踪）——这就是工坊「收章结算正式状态」的对应物，不另造

失败语义：蒸馏失败或未确认不写 `scenes.body`；汇稿前 canon 状态不动。

## 数据层（database.ts）

新表：

```sql
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_number INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT DEFAULT '',
  goal TEXT DEFAULT '',
  status TEXT DEFAULT 'open',      -- open / distilled
  body TEXT DEFAULT '',            -- 收场后的蒸馏正文
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS scene_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  role TEXT NOT NULL,              -- user / assistant
  content TEXT NOT NULL,
  state_patch TEXT DEFAULT '{}',   -- 本轮解析出的状态补丁
  created_at TEXT,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);
```

迁移列（`addColumnIfMissing`）：`project_core.creation_mode`、`blueprints.creation_mode`、`blueprints.working_state`。

## 主进程

- `repositories/scene-repository.ts`：scenes / scene_turns CRUD、`commitScene(id, body)`、章级 working_state 读写
- `db-controller.ts` 新增 channels（走现有 `db:*` 模式）：
  `db:scene-list`（按章）、`db:scene-create`、`db:scene-update`、`db:scene-delete`、
  `db:scene-turn-list`、`db:scene-turn-add`、`db:scene-turn-delete-last`、
  `db:scene-commit`、`db:chapter-working-state-get` / `-set`
- LLM 调用**不在主进程新增**：沿用渲染端 `llm-store.generateStream`（与写稿命令同路）

## 渲染端服务（src/services/dialogue/）

纯函数尽量独立可测：

- `state-protocol.ts`：`splitProseAndState(text)` 剥离 `<state>` 块并解析补丁；`mergeWorkingState(current, patch, validNames)`
- `dialogue-prompts.ts`：`buildScenePrompt(...)` 注入 世界观/主角人设/文风(global_guidance+writing_style)/角色卡与当前状态/章目标/场目标/历史对话；`buildDistillPrompt(...)`
- `dialogue-service.ts`：`generateTurn`（流式，onDone 落两条 turn + 合并状态）、`distillScene`（返回草稿不落库）、`commitScene`、`assembleChapterDraft`（拼场 → `db:draft-create`）

## 前端 UI

- 「小说配置」基本信息区加创作模式选择
- 章节蓝图卡：dialogue 模式章节的「写作此章」变为「对话写作」，打开 `vela://dialogue/{chapter}` 编辑 tab
- `DialogueEditor.tsx`（EditorArea 按前缀路由）：左场列表 / 中对话流（写作字体）＋控场输入 / 收场时蒸馏预览对照可改 / 「汇入草稿箱」按钮；右侧可折叠显示进行中角色状态
- 侧栏草稿箱不动——汇稿产物就是普通草稿

## i18n

`editors` / `commands` 命名空间补 zh-CN / en / ru 三语 key。

## 不做（第一期）

- RAG 召回注入对话 prompt（后续可加）
- Agent 面板改造、场级插图、对话历史导出
- 工坊 FastAPI 后端迁移/退役决策

## 测试

- vitest：`state-protocol`、`dialogue-prompts`、章稿拼装的纯函数测试
- 手工冒烟：建场 → 两轮对话（真流式）→ 收场 → 汇稿 → 草稿箱可见 → 定稿跑后处理
