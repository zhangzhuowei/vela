# 对话创作模式 · 多线联动（中档）规格

日期：2026-08-31

## 一句话

给「场」加一个可选的**线（storyline）标签**，并可选把**同一条线上一场的正文摘要**注入本场生成提示词，解决多线并行时的同线连续性。不用则完全退回现状（轻档）。

## 开关（每书一个下拉）

小说配置页新增字段 `multilineMode`（存 `project_core`）：

- `off`（默认）：无任何变化，等同现状
- `summary`：启用「线」标签 + 生成时注入「同线上一场正文摘要」

（第三档「剧情线状态注入」不在本期，之后作为 `canon` 追加。）

## 数据

- `scenes` 加列 `line TEXT DEFAULT ''`（线名，空=未归线）。
- `scenes` 加列 `summary TEXT DEFAULT ''`（该场正文的 LLM 摘要，缓存用）。
- 都用 `addColumnIfMissing` 迁移，老库自动补。线名自由文本，同章内同名即同线。

## 主进程

- `SceneData` 增字段 `line`；`rowToScene` 读出；`SceneRepository.update` 支持 `{ line }`。
- `SceneData` 增字段 `summary`。
- 新增 `SceneRepository.prevInLine(chapterNumber, line, beforeSeq)`：返回同章、同线、seq 更小且**已收场**的最后一个场（供取摘要）。
- 新增 `SceneRepository.setSummary(id, summary)`：写缓存。
- IPC：`db:scene-update` 扩展 patch 含 `line`；新增 `db:scene-prev-in-line`、`db:scene-set-summary`。

## 摘要来源（真 LLM 摘要 + 缓存）

- 摘要由模型生成（新增模板 `dialogue_scene_summary`，可被 Mod 覆盖）。
- **懒生成 + 缓存**：只有开了多线、且某后续同线场要生成时，才对上一场生成摘要，写入 `scenes.summary`；之后复用，不重复调用。关多线的书永不触发，零成本。
- 摘要在「场内生成」真正开写**之前**同步取一次（有缓存直接用，无则调一次模型）——首次会多一次调用的延迟，可接受。
- 摘要用哪个模型：复用蒸馏模型选择（`vela-distill-model`），无则默认生成模型。

## 提示词

`dialogue_scene` 模板新增变量 `{{line_context}}`：

- `summary` 模式且找到同线上一场：`本线（{line}）前情：{prev.title}——{body 前 300 字}…`
- 否则空串（模板里 `{{line_context}}` 渲染为空，配合现有空段裁剪）

`buildSceneMessages` 增可选入参 `lineContext?: string`，拼进 system。

## 前端

- 场列表每行显示线名徽标（有则显示）。
- 建场输入框旁/场目标行加一个「线」输入（`summary` 模式才显示），失焦存 `db:scene-update`。
- `off` 模式：线相关 UI 全部隐藏，行为与现状一致。
- 生成前（`dialogue-service.generateTurn`）：若本书 `multilineMode==='summary'` 且本场有 line，调用 `db:scene-prev-in-line` 取摘要传入 `lineContext`。

## 不做（本期）

- 不改汇稿顺序（仍按 seq；多线交替靠作者排列场序）。
- 不注入「其它线」内容，只注入「同线上一场」。
- 不做剧情线状态对象（重档，后续 canon 扩展）。

## 测试

- 纯函数：`buildSceneMessages` 带 `lineContext` 时注入、不带时不注入（vitest）。
- 迁移/仓储：`prevInLine` 只返回同线已收场、seq 更小的最近一场（可加后端级测试，或靠手工冒烟）。
