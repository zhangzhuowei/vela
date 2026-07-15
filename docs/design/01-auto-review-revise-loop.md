# 设计文档 #1：自动审校 → 重写闭环（Auto Review-Revise Loop）

## 1. 目标

把 vela 现有的三个手动步骤（审稿 → 审稿修复 → 定稿）串成一个可一键触发的自动闭环：

> 审稿 → 若存在 `error` 级问题 → 自动修复 → 自动合并为新草稿版本 → 再审稿 → …最多 N 轮 → 通过（无 error）或达轮次上限才停。

全程复用现有、已跑通的 Command，不重写审稿/修稿逻辑，只新增一个"编排器 workflow"。

## 2. 现状（复用点）

| 已有组件 | 位置 | 作用 |
|---|---|---|
| `ReviewChapterCommand` | `src/services/workflows/commands/review-chapter.command.ts` | 调 `consistency_check` 模板，返回结构化 JSON `{items:[{category,severity,quote,description}],summary}`，写入 `reviews` 表 |
| `RefineFromReviewCommand` | `src/services/workflows/commands/refine-from-review.command.ts` | 调 `refine_from_review` 模板，产出修订稿，写入 `revisions` 表（`revisionType:'review-fix'`, `status:'pending'`），打开 diff |
| `consistency_check` prompt | `src/services/prompt-templates.ts` | severity 取值 `error/warning/pass`，已是机器可判定 |
| workflow 引擎 | `src/stores/workflow-store.ts` | `startWorkflow(definition)` 顺序执行 steps，`context.cancelled` 支持中断 |
| draft/revision 仓库 | `electron/repositories/{draft,revision}-repository.ts` | 版本化草稿、修订分支、`markMerged` |

**关键优势**：审稿已返回带 `severity` 的 JSON，"是否通过"可程序化判定（`items` 中无 `error` 即通过），不需要像 Python 版那样靠关键词猜。

## 3. 合并入口（已核实，无需新增 IPC）

合并"修订稿 → 新草稿版本"所需的两个 IPC **均已存在**（见 `src/shared/ipc-channels.ts`、`electron/controllers/db-controller.ts`）：

- `db:draft-next-version(chapterNumber) -> number`
- `db:draft-create({ chapterNumber, version, source:'rewrite', content, wordCount }) -> { success, id }`
- `db:revision-mark-merged(revisionId, mergedToDraftId) -> { success }`

因此自动合并 = 组合调用：
```ts
const version = await ipc.invoke('db:draft-next-version', chapterNumber)
const { id: newDraftId } = await ipc.invoke('db:draft-create', {
  chapterNumber, version, source: 'rewrite',
  content: refinedContent, wordCount: refinedContent.length,
})
await ipc.invoke('db:revision-mark-merged', revisionId, newDraftId)
// 新草稿路径：`vela://draft/${newDraftId}`
```
参考现有 UI 合并逻辑：`src/services/draft-index.ts` 的 `markRevisionMerged` + `src/services/version-service.ts` 的 `revertToVersion`（同样用 `db:draft-next-version` + `db:draft-create`）。

审稿 JSON：`ReviewChapterCommand.execute()` 直接返回清洗后的 JSON 字符串，闭环里 `parseJSON` 即可，无需再查 `reviews` 表。

## 4. 设计

### 4.1 新增文件

```
src/services/workflows/commands/auto-review-loop.command.ts   # 编排 Command
src/services/workflows/chapter-workflow.ts                     # 新增 createAutoReviewLoopWorkflow()（在现有文件追加）
```

### 4.2 判定函数（纯函数，可单测）

```ts
// auto-review-loop.command.ts
interface ReviewItem { category: string; severity: 'error' | 'warning' | 'pass'; quote?: string; description: string }
interface ReviewResult { items: ReviewItem[]; summary: string }

/** 阻断级问题数：默认只有 error 才算不通过；可配置为 error+warning */
function blockingCount(r: ReviewResult, gate: 'error' | 'error+warning'): number {
  return r.items.filter(it =>
    it.severity === 'error' || (gate === 'error+warning' && it.severity === 'warning')
  ).length
}
```

### 4.3 编排 Command（核心）

`AutoReviewLoopCommand.execute()` 伪代码：

```
输入: { chapterNumber, draftPath, draftContent, maxRounds=3, gate='error', autoMergeLastRound=true }

currentDraftPath = draftPath
currentContent  = draftContent
for round in 1..maxRounds:
    // 1. 审稿（复用）
    reviewRaw = new ReviewChapterCommand({draftPath: currentDraftPath, draftContent: currentContent, chapterNumber}).execute(...)
    review    = parseJSON(reviewRaw)
    callbacks.log(`第${round}轮审稿：error=${blockingCount(review,'error')} warning=...`)

    // 2. 门控判定
    if blockingCount(review, gate) === 0:
        callbacks.log('✅ 通过审校门控，闭环结束')
        return { passed: true, rounds: round, finalDraftPath: currentDraftPath }

    // 3. 末轮不再修（避免改完没复审留下未验证版本）——策略可选
    if round === maxRounds:
        break

    // 4. 审稿修复（复用）→ 得到 pending 修订
    refineRes = new RefineFromReviewCommand({
        draftPath: currentDraftPath, draftContent: currentContent,
        reviewReport: reviewRaw, chapterNumber,
    }).execute(...)                       // 内部 db:revision-create，返回修订 id/正文

    // 5. 自动合并修订 → 新 draft 版本（组合已有 IPC，见 §3）
    version    = await ipc.invoke('db:draft-next-version', chapterNumber)
    newDraft   = await ipc.invoke('db:draft-create', {chapterNumber, version, source:'rewrite', content: refinedContent, wordCount: refinedContent.length})
    await ipc.invoke('db:revision-mark-merged', refineRevisionId, newDraft.id)
    currentDraftPath = `vela://draft/${newDraft.id}`
    currentContent   = refinedContent

return { passed: false, rounds: maxRounds, finalDraftPath: currentDraftPath, lastReview: review }
```

要点：
- **每轮都在最新草稿版本上审**，天然利用 vela 的版本化，历史全留痕（reviews/revisions 表按 index 递增）。
- **取消支持**：`ReviewChapterCommand`/`RefineFromReviewCommand` 内部的 `callLLM` 已监听 `context.cancelled`；编排循环在每轮开头也检查 `context.cancelled`，用户可随时中断。
- **门控可配**：`gate='error'`（默认，只挡严重矛盾）或 `'error+warning'`（严格模式）。
- **不打开 diff 视图**：自动模式下 `RefineFromReviewCommand` 会 openFile 打开 diff——需给它加一个 `silent` 选项跳过 UI 打开（见 4.5）。

### 4.4 workflow 定义

在 `chapter-workflow.ts` 追加：

```ts
export function createAutoReviewLoopWorkflow(params: {
  chapterNumber: number; chapterTitle: string; draftPath: string; draftContent: string;
  maxRounds?: number; gate?: 'error' | 'error+warning';
}): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: `🔁 自动审校闭环 — 第${params.chapterNumber}章`,
    steps: [{
      name: '审校闭环',
      description: `审稿→修复→复审，最多 ${params.maxRounds ?? 3} 轮`,
      executor: async (step, context, callbacks) => {
        const { AutoReviewLoopCommand } = await import('./commands/auto-review-loop.command')
        return new AutoReviewLoopCommand(params).execute({ step, context, callbacks })
      },
    }],
    onComplete: { mode: 'open', message: `第${params.chapterNumber}章审校闭环结束` },
  }
}
```

### 4.5 对现有 Command 的最小改动

- `RefineFromReviewCommand`：构造参数加可选 `silent?: boolean`。为 `true` 时跳过 `useEditorStore().openFile(diff)`，只创建 revision 并 `return { revisionId, content }`（当前返回的是 refined 字符串，需要把 `createRes.id` 也暴露出来）。
- `ReviewChapterCommand`：加可选 `silent?: boolean`，为 `true` 时跳过打开审稿报告 tab。二者默认 `false`，不影响现有手动流程。

### 4.6 数据库

- **无需新表，无需新 IPC**。reviews / revisions / drafts 表 + 现有 `db:draft-create` / `db:draft-next-version` / `db:revision-mark-merged` 已足够（见 §3）。

## 5. UI 接入（最小）

- 草稿箱/编辑器工具栏加一个按钮"🔁 自动审校"（放在现有"审稿""审稿修复"旁），调 `useWorkflowStore.startWorkflow(createAutoReviewLoopWorkflow(...))`。
- 参数（maxRounds、gate）先用默认值硬编码，后续可加设置项。

## 6. 验证

1. 单测 `blockingCount` / `parseJSON` 边界（vitest 已在依赖里）。
2. 手动：造一章有明显矛盾的草稿，跑闭环，看日志逐轮 error 数下降、reviews/revisions 表按轮递增、最终 draft 版本正确。
3. 门控为 `error` 时，只有 warning 的章节应 1 轮即通过。

## 7. 工作量与风险

- 工作量：**小**（1 个新 Command + 1 个 workflow + 2 处 silent 开关 + 可能 1 个合并 IPC）。
- 风险：**低**，全部架在已跑通组件上；主要风险是缺口#1 的合并入口，需先核实。
- 回退：删除新增文件 + 撤销 silent 开关即可，不动主流程。
