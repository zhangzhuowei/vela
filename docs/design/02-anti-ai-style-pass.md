# 设计文档 #2：去 AI 味润色 Pass（Anti-AI-Style Pass）

## 1. 目标

在定稿前增加一个可选的"去 AI 味"环节，专门检测并改写"一眼是 AI 写的"文本特征（段尾升华总结、滥用"仿佛/犹如/宛如"、万能过渡句、排比堆砌、情绪解说、机械对话腔），降低被平台 AI 检测（如腾讯朱雀）判定的概率，同时不破坏情节、风格与篇幅。

对标 Claude-Book 的 `perplexity-improver`，但落地为 vela 的 workflow Command，并复用 vela 已支持的本地模型（Ollama）能力。

## 2. 现状

- vela 目前只在**写稿 prompt 里内联了"AI 味反制"指令**（`first_chapter_draft` / `next_chapter_draft` 的 `systemSuffix`：禁止段尾总结句、限制"仿佛/犹如/宛如"≤3 次、对话要区分语气等）。这是"生成时预防"，没有"生成后检测+定向清洗"的独立环节。
- 已有 `analyze_writing_style` 模板 + `AnalyzeWritingStyleCommand`（每 5 章自动学文风），但那是学习风格，不是去 AI 味。
- 已支持 Ollama 等本地模型（`llm-store` 的 `models` 列表 + `generateStream(messages, cb, modelId)` 可按需指定模型）。

## 3. 设计（两层，建议先做 Tier 1）

### Tier 1：LLM 定向清洗 Pass（先做，任何模型可用）

**新增 prompt 模板** `deaify_polish`（加入 `BUILTIN_PROMPTS` 并列入 `EDITABLE_PROMPT_KEYS`，用户可改）：

- `systemRole`：资深网文责编，专治"AI 腔"。
- 输入变量：`{{draft_content}}`、`{{writing_style}}`（复用项目文风配置，保证清洗后仍贴合作者风格）、`{{intensity}}`（清洗强度：轻/中/重）。
- 指令要点（可编辑）：
  1. 删除/改写段尾升华与总结句（"他知道，这一切才刚刚开始""命运的齿轮开始转动"等）。
  2. "仿佛/犹如/宛如/像是"合计压到阈值内，改为具体动作/感官细节。
  3. 打散机械排比与三段式；消除万能过渡句（"与此同时""不知过了多久"滥用）。
  4. 对话去"播音腔"，按角色赋予口语差异。
  5. 情绪"展示而非解说"（去掉"他感到很愤怒"式直陈）。
  6. **硬约束**：保持情节、人物、设定、篇幅不变；最小改动；只输出正文。
- `systemSuffix`：纯文本、双引号对话、段间空行等排版铁律（与现有 draft 模板一致）。

**新增 Command** `src/services/workflows/commands/deaify.command.ts`：

```ts
export class DeaifyCommand extends BaseWorkflowCommand<string> {
  constructor(private params: {
    chapterNumber: number; draftPath: string; draftContent: string;
    intensity?: '轻' | '中' | '重'; modelId?: string; silent?: boolean;
  }) { super() }

  async execute({ callbacks, context }) {
    const tpl = getPromptTemplate('deaify_polish')
    const style = useProjectStore.getState().currentProject?.novelConfig.writingStyle ?? ''
    const builder = new ChapterPromptBuilder(tpl)
      .withDraftContent(this.params.draftContent)
      .withWritingStyle(style)
      .withIntensity(this.params.intensity ?? '中')   // 需在 prompt-builder 加对应 with 方法
    const cleaned = this.stripThinkingTags(
      await this.callLLMWithBuilder(builder, callbacks, undefined, context, this.params.modelId)
    )
    // 落库为一条 revision（type 复用 'refine'，或新增 'deaify'），保持可追溯 + 可 diff
    const base = await parseDraftMeta(this.params.draftPath)
    const revIndex = await ipc.invoke('db:revision-next-index', base.id)
    const { id } = await ipc.invoke('db:revision-create', {
      baseDraftId: base.id, revisionIndex: revIndex, revisionType: 'refine',
      content: cleaned, wordCount: cleaned.length, userPrompt: '[去AI味]',
    })
    if (!this.params.silent) { /* openFile diff 视图，同 RefineFromReviewCommand */ }
    return cleaned
  }
}
```

> 说明：`callLLMWithBuilder`/`callLLM` 目前签名没有透传 `modelId`——需要小改 `base-command.ts`，把可选 `modelId` 透传到 `llmStore.generateStream(msgs, cb, modelId, options)`（`generateStream` 本就支持第三参 `modelId`）。这对文档 #3 的"按任务派模型"也是必需前置。

### Tier 2：本地模型"可疑句"检测 + 定向重写（可选，后做）

对标 perplexity-improver，但要务实：

- **理想**：用本地 LM 的 token logprob 算句子困惑度，低困惑度（过于套路）标记为可疑。**但** Ollama 对 logprobs 的暴露有限，未必稳定可得——**实现前需核实** Ollama/所配本地模型是否返回 logprobs。
- **务实降级方案**（不依赖 logprobs）：本地启发式检测器
  - 陈词滥调词典匹配（可维护的 `cliches.json`：套路化短语、段尾升华模板）。
  - n-gram 自相似度（段落间高相似模板）。
  - "仿佛/犹如"等标记词密度统计。
  - 命中句子高亮 → 只对命中片段调用 Tier 1 的清洗（降低 token 消耗、减少误伤未命中的好句）。
- 交付形式：`deaify-detector.ts`（纯函数检测，可单测） + 复用 `DeaifyCommand` 做定向重写。

## 4. 集成点（三选一或组合，建议 A + C）

- **A. 独立按钮/命令**："✨ 去AI味"，对当前草稿跑 `DeaifyCommand`，产出 diff 供人工合并。低风险、最先落地。
- **B. 定稿后处理步骤**：在 `buildFinalizePostProcessSteps`（`finalize-chapter.command.ts`）加一个 `critical:false` 的可选步骤，由项目设置开关控制。注意：后处理目前在**正文已定稿写库之后**跑，去AI味应在定稿**之前**，故 B 不理想，除非把它前移到 `FinalizeChapterCommand.execute` 写库前。
- **C. 批量管线中的一环**（见文档 #3）：作为可配置步骤插在"审校闭环"之后、"定稿"之前。

## 5. 数据库

- 复用 `revisions` 表。可选：给 `revision_type` 增加枚举值 `'deaify'`（`RevisionRepository.create` 的 `revisionType` 类型放宽），便于统计与区分；不加也能用 `'refine'` 兜底。
- 无需新表。

## 6. 验证

- 造一段"AI 味"浓重样本（多段尾升华 + 高频"仿佛"），跑 `DeaifyCommand`，人工对比 diff：套路句应被改写，情节/字数基本不变。
- Tier 2 检测器：对已知样本单测命中率（vitest）。
- 若接朱雀等外部检测，仅作离线人工抽检参考，不进 CI。

## 7. 工作量与风险

- Tier 1：**小-中**（1 prompt + 1 Command + `base-command` 透传 modelId + builder 加 `withIntensity/withWritingStyle`）。
- Tier 2：**中**（检测器 + 词典维护），且 logprob 路线**需先核实** Ollama 能力，建议直接走启发式降级方案。
- 风险：清洗过度可能伤及作者风格——用 `intensity` 分级 + `writing_style` 约束 + diff 人工确认（非批量场景）来缓解。
