# 参考作品拆书

范文是项目内独立实体：分章后按「L0 章摘要 → L1 阶段轴 + 人物线轴 → L2 总纲 → L3 推进模式」生成分层大纲。只读写当前项目 `.vela/vela.db` 的 `ref_*` 表，不进写作知识库，不改本书配置 / 架构 / 角色卡。

## 已定决策

| 项 | 决定 |
| --- | --- |
| 导入到本书 | 第一版不做；用法 B「原著人物可出场」留给后续 |
| 层级 | L0 章摘要 / L1 阶段轴 + 人物线轴 / L2 总纲 / L3 推进模式 |
| 抽样 | 范围 `from..to`，默认前 200 章；可继续跑剩余 |
| 分模型 | `digestModelId`（L0）、`outlineModelId`（L1～L3、微调、单块重跑）；空 = 默认生成模型。创建后可在详情页改，任务运行中不可改 |
| 挂 mod | `ref_*` 可被 mod `templates` 覆盖；命令 `attachModGuidance = true`；启用集合取项目 `mods.json` |
| 存放 | 项目级 SQLite；跨书复用留给导出 / 导入参考 |
| 范文正文 | `ref_chapters.content`，不进 LanceDB |
| 人物线 | L0 记每角色阶段与功能；本名 + 别名由用户在 L0 后确认；矩阵与统计本地计算 |

## 数据表

- `ref_works`：作品、抽样进度 `analyzed_from/to`、两个模型 id、状态
- `ref_chapters`：章号、标题、正文、字数
- `ref_digests`：L0（摘要、事件、钩子、主攻线、角色状态、引出、亲密、失败信息）
- `ref_lines`：本名、别名、kind、锁定、线弧
- `ref_stages`：阶段轴（目标、敌人、入段钩子、出段爆点、锁定）
- `ref_outlines`：L2 / L3 Markdown、版本、锁定
- `ref_revisions`：作用域微调快照，可回退

## 模板 key

`ref_chapter_digest`、`ref_stage_segment`、`ref_line_arc`、`ref_global_outline`、`ref_progression_pattern`、`ref_refine`

## 续跑

`analyzedTo` 是从第 1 章起连续 `status=ok` 的最后一章，不是某次请求的 `to`。继续跑取 `listPendingChapterNumbers` 的第一个未成功章，批次最多 200。并发下后章先成功也不会把中间空洞标成已拆完。

## 取舍

- 启用 mod 直接用项目 `mods.json`，不做按次临时排除。
- 阶段切分靠 LLM；跨批用 `continuesPrevious` 与标题相似合并。切错用锁定 + 微调，不再全局重排。L2 / L3 / 阶段 / 人物线 / 单章可点「重跑」单独生成（阶段重跑保持起止章）。微调是按建议改写，不是重跑。
- 全书约 3M 字全跑约 1000～1500 次 L0；创建时先给出预估，由用户选抽样或全跑。
- L0 单次正文上限 8000 字；超过则按空白段 / 换行 / 句读打包成多块（每块 ≤8000），再按块调用并合并。无边界的超长串才硬切。
- 任务中途退出时 `status` 可能停在 running；打开项目且当前没有拆书任务时，按已完成的 L0 收口为 done / error / idle。
- L0 `characterStates` 的 stage / func 两套枚举不相交；填反时落库前纠正（对调或落到 none / mention），未知值仍拒绝。
