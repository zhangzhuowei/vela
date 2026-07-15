# 设计文档 #3：批量无人值守管线 + 质量门（Batch Unattended Pipeline with Quality Gates）

## 1. 目标

一键批量生成 [起始章, 结束章]，每章自动跑完整子管线：

> 写稿 →（可选）修稿 → 自动审校闭环(文档#1) →（可选）去AI味(文档#2) → 通过质量门 → 定稿（含后处理）

支持：中途取消、按任务派不同模型、失败策略（停/续/暂停待人工）、断点续跑（跳过已定稿章）、开跑前成本预估确认。对标 libriscribe 的 `chapter_writing: auto` + Claude-Book 的 gate。

## 2. 现状（复用点）

| 组件 | 位置 | 复用方式 |
|---|---|---|
| workflow 引擎 | `src/stores/workflow-store.ts` | `startWorkflow(def)` 顺序执行 steps；`context.cancelled` 中断；`WorkflowType` 已含 `'batch_generate'` |
| 写稿 | `commands/generate-draft.command.ts` `GenerateDraftCommand` | 直接调 |
| 修稿 | `commands/refine-draft.command.ts` `RefineDraftCommand` | 可选步骤 |
| 审校闭环 | 文档#1 `AutoReviewLoopCommand` | 核心质量门 |
| 去AI味 | 文档#2 `DeaifyCommand` | 可选步骤 |
| 定稿+后处理 | `commands/finalize-chapter.command.ts` `FinalizeChapterCommand` | 直接调（内含 KB 导入/章节要点/角色卡更新） |
| 前置校验 | `services/workflow-guards.ts` `guardChapterWriting(n)` | 每章开跑前校验 |
| 断点判定 | `db:draft-get-finalized(n)` / `db:draft-get-max-finalized-chapter` | 续跑跳过 |
| 按任务派模型 | `llm-store.generateStream(msgs, cb, modelId)` | 写稿用 A、审稿/去AI味用 B |

**已实现的一致性护栏（batch 天然受益）**：`guardChapterWriting` 已强制"第 n 章写稿前，第 n-1 章必须已定稿且后处理关键步骤全通过"。这正是无人值守跑长篇不崩人设/不断上下文的关键不变量，batch 复用即可。

**已有的容错边界（核实结论，决定 §3.6 的必要性）**：
- `workflow-utils.ts` 有通用重试包装器 `withRetry`，但**仅用于定稿后处理流水线**（PostProcessPipeline 的单步重试），**不覆盖写稿/审稿的核心 LLM 调用**。
- 知识库有检索降级（embedding 失败 → FTS 全文检索，见 `knowledge-base.ts` / `vector-store.ts`）。
- **核心 `generateStream` 调用路径（`base-command.ts` 的 `callLLM`）没有任何重试，也没有跨模型/服务商回退。** 手动单章场景无所谓，但**无人值守批量长跑时，一次网络抖动 / 429 / 超时就会让整章 step 抛错、进而 break 整个批量 run**——这是长篇 batch 的头号稳定性风险，故本设计新增 §3.6。

## 3. 设计

### 3.1 新增文件

```
src/services/workflows/batch-workflow.ts                 # createBatchGenerateWorkflow()
src/services/workflows/commands/batch-chapter.command.ts # 单章子管线编排 Command（可复用于非批量）
```

### 3.2 配置对象

```ts
interface BatchOptions {
  startChapter: number
  endChapter: number
  refine: boolean           // 是否插入"大神级修稿"
  autoReview: boolean       // 是否插入审校闭环
  reviewMaxRounds: number   // 默认 3
  reviewGate: 'error' | 'error+warning'
  deaify: boolean           // 是否插入去AI味
  onReviewFail: 'stop' | 'continue' | 'pause'  // 质量门未过时的策略
  models?: { write?: string; review?: string; deaify?: string }  // 按任务派模型（modelId）
  modelsFallback?: { write?: string[]; review?: string[]; deaify?: string[] }  // 各任务的备用模型链（失败切换）
  llmMaxRetries?: number    // 单次 LLM 调用的重试次数（默认 2）
  resume: boolean           // 跳过已定稿章
}
```

### 3.3 单章子管线（`BatchChapterCommand`）

```
execute(chapterNumber):
  // 0. 续跑跳过
  if opts.resume && await ipc('db:draft-get-finalized', n): log('跳过已定稿'); return {status:'skipped'}

  // 1. 前置校验（复用护栏）
  guard = await guardChapterWriting(n)
  if !guard.ok: throw new Error(guard.message)   // 上下文不完整，宁可停

  // 2. 写稿
  if context.cancelled: return
  draft = await new GenerateDraftCommand(chapterInfoFromBlueprint(n)).execute({...})
       // GenerateDraftCommand 内部已 db:draft-create 出草稿版本
  draftPath = `vela://draft/${draft.id}`; content = draft.content

  // 3. 可选修稿（产出新版本或原地）
  if opts.refine: {content, draftPath} = await runRefine(...)

  // 4. 审校闭环（质量门核心，复用文档#1）
  gateReport = { passed: true }
  if opts.autoReview:
     gateReport = await new AutoReviewLoopCommand({chapterNumber:n, draftPath, draftContent:content,
                        maxRounds:opts.reviewMaxRounds, gate:opts.reviewGate,
                        modelId:opts.models?.review}).execute({...})
     {draftPath, content} = latestFrom(gateReport)

  // 5. 可选去AI味（复用文档#2）
  if opts.deaify:
     content = await new DeaifyCommand({chapterNumber:n, draftPath, draftContent:content,
                        modelId:opts.models?.deaify, silent:true}).execute({...})
     // 合并为新版本（同文档#1 §3 组合 IPC）
     draftPath = await mergeToNewDraft(n, content)

  // 6. 质量门判定
  if opts.autoReview && !gateReport.passed:
     switch opts.onReviewFail:
        'stop':     throw new Error(`第${n}章审校未通过（残留 error），已停止批量`)
        'pause':    context 标记该章需人工，暂停后续（见 3.4）
        'continue': callbacks.log(`⚠️ 第${n}章带问题定稿`) // 记录但放行

  // 7. 定稿 + 后处理（复用，含 KB/章节要点/角色卡）
  await new FinalizeChapterCommand({draftPath, draftContent:content, chapterNumber:n,
                                    chapterInfo}).execute({...})
  return {status:'finalized'}
```

### 3.4 批量 workflow

用 workflow 引擎的 steps 承载每一章（1 章 = 1 step），天然获得进度显示、日志、取消：

```ts
export function createBatchGenerateWorkflow(opts: BatchOptions): WorkflowDefinition {
  const steps = []
  for (let n = opts.startChapter; n <= opts.endChapter; n++) {
    steps.push({
      name: `第${n}章`,
      description: `写稿→${opts.autoReview?'审校闭环→':''}${opts.deaify?'去AI味→':''}定稿`,
      executor: async (step, context, callbacks) => {
        const { BatchChapterCommand } = await import('./commands/batch-chapter.command')
        return new BatchChapterCommand(n, opts).execute({ step, context, callbacks })
      },
    })
  }
  return { type: 'batch_generate', title: `📚 批量生成 第${opts.startChapter}-${opts.endChapter}章`, steps }
}
```

- **取消**：引擎在每个 step 前查 `context.cancelled`；子命令内部（LLM 调用、闭环每轮）也已监听，随时可停。
- **失败即停**：某章 step 抛错 → 引擎标记该 run `failed` 并 break，后续章不跑（符合"上下文断裂不应继续"）。
- **`pause` 策略**：借用引擎的 `stepByStep`/`waiting` 机制——审校未过时把该 run 置 `waiting`，等用户在 UI 处理（合并/放行/终止）后 `confirmContinue(runId)`。

### 3.5 按任务派模型

`generateStream` 第三参已支持 `modelId`。需前置改造（与文档#2 共用）：`base-command.ts` 的 `callLLM/callLLMWithBuilder` 透传可选 `modelId` 到 `generateStream`。各子 Command 从 `opts.models` 取对应任务的 modelId：写稿用强模型、审稿/去AI味用便宜或本地模型，显著降本。

> 注：当前"默认模型"存于 `~/.vela/config.json`（`llm:get-default-model`）。若已有"按用途指派模型"的配置结构（README 提及），batch 直接读取；否则本功能顺带补一个 `taskModels` 配置项。**实现前需核实**该配置是否已存在。

### 3.6 LLM 调用韧性：重试 + 备用模型（长跑必需前置）

**问题**：核心 `generateStream` 路径（`base-command.ts` 的 `callLLM`）无重试、无回退（见 §2 核实结论）。无人值守批量下，单次瞬时错误就会中断整批。

**改造**（全部为增量、可选参数，不影响现有手动流程）：

1. `base-command.ts` 的 `callLLM` 包一层重试：复用 `workflow-utils.ts` 的 `withRetry`，或内联"最多 `llmMaxRetries` 次、指数退避"逻辑。仅对**可恢复错误**重试（超时、429、5xx、空响应、JSON 解析失败），对用户取消（`context.cancelled`）与鉴权类错误（401/403）不重试直接抛。
   ```ts
   protected async callLLM(prompt, systemPrompt, callbacks, options?, context?, modelIds?: string[]) {
     const chain = (modelIds?.length ? modelIds : [undefined])   // undefined = 默认模型
     let lastErr
     for (const mid of chain) {                 // 2) 备用模型链：逐个尝试
       for (let attempt = 0; attempt <= (this.maxRetries ?? 2); attempt++) {
         if (context?.cancelled) throw new Error('工作流已取消')
         try { return await this.callOnce(prompt, systemPrompt, callbacks, options, context, mid) }
         catch (e) {
           if (isUserCancel(e) || isAuthError(e)) throw e
           lastErr = e; callbacks.log(`⚠️ LLM 调用失败(model=${mid ?? '默认'}, 第${attempt+1}次)，${retriable(e)?'重试':'切下一个模型'}`)
           if (!retriable(e)) break            // 该模型不可恢复 → 直接切下一个
           await sleep(backoff(attempt))
         }
       }
     }
     throw lastErr
   }
   ```
2. 备用模型链：`callLLMWithBuilder` 增加可选第 5 参 `modelIds: string[]`，由各子 Command 从 `opts.modelsFallback?.<task>` 传入（首选 = `opts.models.<task>`，其后为备用）。
3. 影响范围：这是 `base-command` 的**基础能力增强**，写稿/审稿/去AI味/后处理所有 Command 自动受益；手动场景不传 `modelIds` 时行为不变（仅多了重试）。

> 与文档#2 的 `modelId` 透传是同一处改造的自然延伸：先透传单个 `modelId`，再扩成 `modelIds[]` 链 + 重试。

## 4. 开跑前成本预估与确认

- **调用量预估**：`(endChapter-startChapter+1) × 每章预计 LLM 调用数(写1 + 审N + 修N + 去AI味1) × 每次约 word_number token`。
- **金额预估（顺带补 USD/￥ 估算）**：vela 目前只统计 token/次数，**不算钱**（核实：全库无 `cost/pricing/单价` 相关代码）。批量场景建议顺带补一张"模型→单价（输入/输出 /1K token）"表（放 `~/.vela/config.json` 的 `taskModels` 旁或模型档案 `ModelProfile` 上），用预估 token × 单价给出金额区间。落地成本很小，但对"一次跑几百章"的心理预期很关键。
- 弹确认框（含"可能消耗大量 token/额度"警告 + 金额区间），对标 libriscribe 的开跑确认。
- 结合已有 `stats-service`（`db:get-llm-stats`）在跑完后给实际 token 用量汇总；若补了单价表，同时给实际花费。

## 5. 断点续跑

- `resume:true` 时，每章开头查 `db:draft-get-finalized(n)`，已定稿则跳过。
- 天然实现"跑到一半中断，重开接着跑"——因为 vela 定稿即落 DB，无额外状态文件（比 libriscribe 的 `.status.json` 更省）。

## 6. 数据库

- **无需新表、无需新 IPC**。全部复用现有 draft/review/revision 表与 `db:*` 通道。
- 仅"按任务派模型"若无现成配置，需在 `~/.vela/config.json` 加一个 `taskModels` 字段（小改 config-controller）。

## 7. 依赖关系与落地顺序

1. 先落 **文档#1（审校闭环）** —— batch 的质量门核心。
2. `base-command.ts` 透传单个 `modelId`（文档#2、#3 共用前置）。
3. **`base-command.ts` LLM 调用韧性（§3.6）**：在 modelId 透传基础上，扩为"重试 + 备用模型链"。手动场景可暂缓，但**批量长跑必须先做**，否则整批易被单次抖动中断。
4. 落 **文档#2 Tier 1（去AI味）**。
5. 最后组装 **batch-workflow + BatchChapterCommand**，把 1/2 作为可选环节插入；可选顺带补"模型单价表 + 金额预估"（§4）。

## 8. 验证

- 小范围先跑（如 3 章），验证：每章写→审→（去AI味）→定稿全通、`guardChapterWriting` 护栏生效、reviews/revisions/drafts 落库正确、后处理（角色卡/章节要点）更新。
- 中途点取消，确认在下一步边界干净停止、无半写脏数据。
- `resume` 复跑，确认已定稿章被跳过。
- 三种 `onReviewFail` 策略各验证一次。

## 9. 工作量与风险

- 工作量：**中**（batch-workflow + 单章编排 Command + 成本确认 UI + modelId 透传 + §3.6 LLM 重试/备用模型）。绝大部分逻辑是编排已有 Command，不重写生成/审稿/定稿。
- 风险：**中**。无人值守长跑的稳定性由四重兜底覆盖：`guardChapterWriting` 上下文不变量 + §3.6 LLM 重试/备用模型（抗瞬时错误）+ 失败即停（抗不可恢复错误）+ 断点续跑（中断后接着跑）。成本失控风险由开跑前 token/金额预估确认缓解。
- 回退：删除新增文件即可；`base-command.ts` 的 modelId/modelIds 透传与重试是纯增量可选参数，不传时行为与现在一致，不影响现有调用。
