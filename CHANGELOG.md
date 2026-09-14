# CHANGELOG

## 0.2.4 — 2026-08-31

工坊版：在原「大纲→写稿→草稿箱」管线之外，新增一条「对话创作」流程与配套的写作 Mod 体系，两套管线按书/按章并存。

### 修复（正文）

- **「（据前文线索）」不再进正文**：这是一致性闸门给知识越权打的编辑标注，不是小说句子。已停止插入；写稿/续写/修稿/对话落盘以及注入上一章结尾时一律剥掉全角/半角两种写法。已写进稿里的，再生成或修一稿会清掉；当前稿可先手动删。

### 新增（设定纲要 · 一期）

- **设定纲要**：小说配置和故事架构之间新增一层「世界怎么运转」的规则条目，侧栏「故事架构」下方入口。一个模块 = 一份四格 Markdown（规则 / 例外 / 进戏 / 禁止），按类型给默认清单（古言、玄幻、都市、科幻、同人、通用；同人多一条「原作硬设定」默认常驻），「主角配置」所有类型都有。
- **单模块 AI 生成 / 按指令改写 / 常驻摘要**：一次只动一个模块，其它模块只以摘要作参照，改「婚姻制度」不会顺手重写「美貌等级」。模板 `setting_module`（可自定义）、`setting_module_summary`。
- **注入方式**：`常驻` 摘要拼成 `{{setting_digest}}` 进第一章 / 后续章写稿、滚动蓝图刷新、对话场内生成、收场蒸馏；`按需` 只同步进本书知识库（文件名 `设定·<模块名>.md`，保存即重导），靠检索或点名取用；`关闭` 两边都不进并清理旧文档。裁决顺序写进摘要头：人物当前状态与已发生事实 ＞ 纲要 ＞ 架构 ＞ 知识库。
- 常驻摘要总预算 1500 字，超出顶栏标红；摘要为空时用「规则」第一段兜底。
- 数据：新表 `setting_modules`；IPC `db:setting-module-*` 带输入校验。

### 新增（设定纲要 · 二期）

- **点名注入**：章节卡和对话场各多一排「涉及设定」芯片（`blueprints.setting_keys` / `scenes.setting_keys`）。被点名的模块在写稿、刷新蓝图、场内生成、蒸馏时**全文**进提示词，并从常驻摘要列表里去重；不靠检索碰运气。关闭的模块不可选。
- **从世界观拆分**：把故事架构的世界观拆进还是空的模块，已有内容的模块不动，多出的规则最多另立 3 个新模块（模板 `setting_split_worldbuilding`）。空页面上有「铺清单并从世界观拆分」一键。
- **交叉检查**：找模块之间的矛盾 / 重复 / 留白，按严重程度列出并附最省事的修法，只报告不改（模板 `setting_cross_check`）。
- **复制为新项目**带上全部模块（知识库文档不复制，新项目保存时重新同步）；**JSON 导入导出**（`vela-setting-bible`，同 key 覆盖、新 key 追加，也接受四格散着放的写法）。
- Agent 工具 `read_setting_bible`：不传模块名给概览，传了给四格全文。
- 设定纲要的生成 / 改写 / 摘要 / 拆分 / 检查都挂本书启用 Mod 的行文指导，避免尺度自审把制度写虚。
- **批量生成**：纲要页「批量生成」勾选多个模块顺序跑（后面的模块能参照前面刚生成的摘要），走任务面板可看进度、可取消；已有内容的模块勾了才重生成。
- **接进「AI 生成架构」**：勾选对话框多了第五步「设定纲要」——按类型铺默认清单并生成所有空模块。新书一条流程：配置 → 架构四步 → 纲要。已有内容时默认不勾。
- 一致性审稿也注入 `setting_digest`，多一条「设定合规」核对；字数不足的自动续写同样带上纲要，不再只有主提示词有。

### 调整（知识库召回名额）

- 写稿、对话场内 / 蒸馏、审稿的知识库召回改为**多取三倍再按来源分名额**：文件名 `设定·` 开头的最多 2 段、`词表·` / `写法示例·` / `基础动作定义` / `姿势详解` 开头的最多 1 段，其余留给已写正文和手导资料；名额没用满按原排名补齐。不改检索算法，词表再密也挤不掉设定和前文。
- 召回里含词表段时自动附一句「只是可选词汇与示范，不得罗列、不得照抄整行，人物视角语气按本书」，不用再往 Mod 里手写。
- 侧栏知识库列表给设定纲要同步的文档和词表类文档加了来源角标。
- **手工导入文档**：知识库侧栏和概览页增加「导入文档」，多选 `.md` / `.txt`；文件名含「不导入」的自动跳过，避免把决策表/场面菜单灌进检索。
- **文档预览 / 删除**：侧栏点一条文档，中间按切片预览；可从知识库删除（设定纲要同步的删后，下次保存模块还会再导回来）。

### 新增（章末收束）

- **小说配置「章末收束」** + **章节蓝图覆盖**：`cliffhanger`（必须卡悬念，缺省，旧书行为不变）或 `smooth`（平稳过渡）。章级空值跟随书级。
- 写稿模板（第一章 / 后续章）与字数不足续写、滚动蓝图刷新都按解析后的本章模式注入，平稳章不再强制卡悬念，刷新也不会再编 `suspenseHook`。
- 复制为新项目会带上书级这项。已自定义过写稿模板的，需自己删掉模板里的「悬念断章大法」或恢复内置，配置才能生效。

### 新增（对话创作模式）

- **对话创作模式**：以「场」为单位逐场对话控场，模型写场景正文并回传 `<state>` 角色状态补丁；收场蒸馏成小说正文对照手改，汇稿按场序拼接后写入原生草稿箱，之后照常走修稿/定稿/canon 结算。开关为工程级默认（`project_core.creation_mode`）+ 章级覆盖（`blueprints.creation_mode`）。
- **进行中角色状态**：整章共享一份，随每轮 `<state>` 补丁合并；右侧面板可折叠、六个标准字段可手动编辑，开章时从角色卡当前状态拷出。
- **知识库召回注入**：场内生成与收场蒸馏都按控场/场目标召回设定切片注入；出场角色按「主角 > 蓝图出场 > 有进行中状态」筛选，防止大工程角色卡撑爆上下文。
- **字数控制**：每轮生成与收场蒸馏各自的目标字数下拉，系统提示词硬性下限 + 控场消息重申 + 篇幅闸门不足八成自动续写（最多 2 轮，流式无缝衔接）。
- **对话体验**：控场快捷指令板、汇稿预览、生成中可停止/撤回/上滑阅读、蒸馏可单独选模型、流式态跨编辑器页签保持。

### 新增（写作 Mod 体系）

- **Mod = 提示词模板覆盖 + 行文指导追加**：全局维护、按书启用可叠加（越晚启用优先级越高），生效优先级 项目自定义 > 全局自定义 > Mod > 内置。
- 标签分类与全局改名/删除、版本历史与回滚、按书钉住版本、单文件 JSON 导入导出、全局禁用；列表搜索/标签过滤/固定高度滚动/已启用置顶，支持百条量级。
- 对话的场内生成与收场蒸馏接入提示词模板体系（`dialogue_scene` / `dialogue_distill`），可被 Mod 覆盖；状态输出协议放 `systemSuffix`，自定义无法破坏解析。

### 新增（多线联动 · 中档）

- 场可标线名；开「同线摘要」时生成本场前注入同一条线上一场的 LLM 前情摘要（懒生成缓存到 `scenes.summary`，复用不重复调用）。每书开关（`project_core.multiline_mode`），关则零成本。
- **场间前情**（与多线独立）：小说配置可关 / 上一场结尾 / 本章已收场摘要。缺省为本章已收场摘要；按场序注入，不依赖线名。收场时预生成摘要缓存。
- 本章场全部删光后，章级进行中角色状态清空（不再从角色卡把旧进度填回）；侧栏可手动清空。
- **复制为新项目**：主页可把当前书的小说配置 + 故事架构四大件拷到新文件夹，不带章节/草稿/角色卡。

### 修复

- **全局自定义提示词覆盖重启失效**：`loadCustomPrompts` 导出却从未在启动时调用，全局覆盖仅在当次会话生效。已在应用初始化时加载（同修复已单独向上游提 PR）。
- 补齐 en/ru 多处 i18n 缺失键（世界观编辑器四大件、伏笔台账、文生图模型、去 AI 味/伏笔抽取模板名等）。
- 模板名/描述在缺 i18n 键时回退模板自带字段，不再显示裸键名。
- 汇入草稿箱后侧栏草稿列表不刷新、场目标占位符缺翻译键、生成时被自动滚动拽回底部等对话页体验问题。

### 数据 / 构建

- `scenes` / `scene_turns` 表；`project_core` 加 `creation_mode` / `multiline_mode` / `chapter_ending`；`blueprints` 加 `creation_mode` / `working_state` / `chapter_ending`；`scenes` 加 `line` / `summary`。均走 `addColumnIfMissing`，老库自动迁移。
- vitest 改由 Electron 内置 Node 运行以对齐 better-sqlite3 ABI；本地应急打包脚本 `scripts/build-win-local.mjs`（`pnpm build:win:local`）绕过 rcedit 竞态。

## 0.2.3

本版是一轮全库性能与正确性审计的集中修复：先修掉直接影响生成质量的正确性 bug，再砍批量写作的 token 与 IPC 浪费，最后处理流式期间的 UI 卡顿与长篇项目的扩展性。

### 修复（正确性）

**第一章写稿的 prompt 残留字面占位符**

`withChapterInfo` / `withFutureBlueprints` / `withUserGuidance` 只在非首章分支注入，而 `first_chapter_draft` 模板引用了这三个变量，未赋值的 `{{var}}` 会原样留在 prompt 里——首章模型看不到本章任务、后续预告与作者微操。三件套提升到公共构建链。同族问题一并修复：`refine_chapter` 模板正文引用 `{{writing_style}}` 但修稿命令从未注入。

**定稿 Gate 判 BLOCK 时静默返回，批量误报成功**

Gate 阻止定稿时只打日志就 `return`，工作流步骤显示成功、批量管线输出「已定稿」，实际章节未定稿，直到下一章前置校验才报错，问题被掩盖到错误位置。改为抛出带章节号与冲突原因的错误。

**角色改名不同步叙事一致性数据（上次改名修复漏掉的另一半）**

`rename` 只更新 `characters` 表，canon 状态表仍挂旧名——改名后 Canon 按新名查不到状态、定稿写回按新名另起一行，角色状态从此分裂，一致性基线是错的。现在同一事务内迁移：状态表主键行（新旧名并存时按更新章合并）、时间线/剧情线/事实表的 characters 数组、其他角色关系映射的键名。摘要与事实陈述等自由文本刻意不替换，避免误伤同名子串。

**向量回填硬编码 2048 维**

`backfillVectors` 自带一份写死 2048 维的重建逻辑，凡模型输出维度非 2048（bge-m3=1024、OpenAI=1536 等）的回填都会写坏 schema。整段删除，写回委托给 `updateChunkVectors`（按实际向量维度建列）；超过 200 条的大批量回填改走一次性重建，不再是数千次串行小事务。

**纯 FTS 模式下每次导入知识库都全表重建**

`addChunks` 的必填字段检查恒含 `vector` 列，而纯 FTS 模式建表时刻意不含该列——每次导入都误判"缺列"走「读全表 → drop → 重建」，开销随知识库线性增长。vector 列改为单独判断（仅本批带向量且旧表无列时重建一次补列）。

**章节题图替换先删后插，失败即丢图**

原实现先删库删盘再插入，INSERT 失败（磁盘满等）时旧题图已经库、盘双删。改为「先立新、后破旧」：插入与删除旧行在同一事务内，提交成功后才清理旧文件。

### 修复（资源生命周期）

**LanceDB 连接从不真正关闭**

连接池的 `closeConnection` 只从 Map 删引用、不调底层 `close()`，且切换/关闭项目时无人调用它（SQLite 会关，LanceDB 不会）——多项目切换后句柄堆积，Windows 上旧项目的 `.vela/lancedb` 目录被句柄锁住，无法删除/备份/同步。现在 `closeConnection` 真正关闭连接；`closeProjectDatabase` 同步清理全部 LanceDB 连接（切换项目、`db:close`、应用退出都会经过）。

**MCP 子进程管理的三个洞**

- 应用退出时没有统一断开，自动连接的 node/python 子进程残留成孤儿进程 → `before-quit` 钩子统一 `disconnectAll`
- MCP server 崩溃后只改状态标记、不拒绝挂起请求，之后每次工具调用都干等满 10 秒超时 → 进程退出时立即拒绝全部 pending、清空该服务器的工具/资源并通知渲染进程
- 每个请求的 10 秒超时定时器成功后不清除，高频调用堆积空转定时器 → 随请求结算清除；另外 Windows 上 `kill()` 只杀直接子进程，改用 `taskkill /T` 按进程树终止（MCP server 经 npx 拉起的孙子进程不再残留）

**SQLite 并发写与缺失索引**

- 补 `busy_timeout = 5000`：批量定稿写回与 UI 保存并发碰撞时自动等待重试，不再直接抛 `SQLITE_BUSY`
- 补高频查询索引：`revisions(base_draft_id)`、`reviews(base_draft_id)`、`post_process_steps(run_id)`、`drafts(status, chapter_number)`、`canon_facts(introduced_at)`——修稿审稿攒多后按草稿加载列表、找最新定稿章、清章事实不再全表扫描。建表语句每次打开项目都会执行，`IF NOT EXISTS` 对老库自动补齐

### 新增

**知识库检索换真中文 FTS + 混合检索**

Tantivy 默认分词器不支持中文，此前的"FTS"实际是把查询逐字拆开做 `LIKE '%主%角%突%破%'` 全表扫描：无相关性排序（分数写死 0.5）、散字垃圾命中（搜「金丹」误中「金色的丹药」）、块数越多主进程卡得越久。经选型验证，改为：

- FTS 索引用 ngram 双字组分词（`@lancedb/lancedb` 0.27 原生支持，零新增依赖），中文获得正确的 BM25 召回与排序，英文同样可用
- 有向量时做真混合检索：FTS 与向量各取一路，RRF 融合排序（原实现"有向量就只用向量"）
- 存量知识库在下次检索/导入时按版本标记自动重建索引（2000 块约 57ms）
- 查询短于 2 字或索引异常时回退逐字 LIKE 兜底；FTS 合法空结果如实返回，不再用散字命中充数

**侧栏长列表虚拟化（`WindowedList`）**

草稿箱/正文稿/Agent 会话历史原来有多少条渲染多少个 DOM 节点，百章项目展开一次构建数千节点。新增手写窗口化组件（零依赖）：跟随最近可滚动祖先（保持侧栏单滚动条交互不变）、行高固定或按行给定、低于 80 条直接平铺（小项目零开销）。顺带消掉两个会被虚拟化放大的 N+1：草稿箱与正文稿的章节标题都改为一次 `db:blueprint-get-all` 取回（原实现逐章/逐文件各打一次 IPC）。

### 优化（token 与 IPC）

**写稿/审稿 prompt 去重 —— Canon 与模板槽位不再重复携带同一份内容**

`renderCanonContext` 此前渲染上一章结尾、本章目标、RAG、文风、全局指导五块，与模板专属槽位完全重复，每次写稿重复计费约数千到上万 token。Canon 渲染收敛为事实基线（正史设定/人物状态/时间线/摘要/剧情线/事实/硬性约束）；角色状态槽位在 Canon 注入成功时只留指针文本，失败时回退完整档案。这些字段仍保留在 Canon 对象上供 Gate 校验。

**Canon 时间线分层渲染 —— 长篇不再无界膨胀**

时间线此前全量逐条进 prompt（每章 5~15 条事件，300 章时十几万字）。改为近 10 章完整渲染 + 更早章节只保留死亡等不可逆事件的压缩行（复用校验器的死亡语义判定），整体 6000 字符上限保近弃远。校验器仍拿全量时间线（第 20 章死的角色第 150 章也不能复活），强度零回退。

**写稿链路残留 IPC 清理**

- `db:project-core-get` / `db:character-get-all` 各读一次全程复用（原来各打 2~3 次）；顺带消除了 core 读取失败时 `worldbuilding` 回退用错拆分下标的隐患
- 章节要点时间线改用共享的一次性取回（写稿路径漏改，第 200 章仍要打 199 次）
- 近 3 章定稿正文一次并行读回，上章结尾与反雷同速览共用（原实现串行且上一章全文读两遍）
- 审稿命令复用 Canon 已取回的数据，不再重复直读角色卡/世界观

**草稿列表去 N+1**

新增 `db:draft-list-all` 通道，`loadAllDrafts` 从按蓝图逐章查询（百章项目一次刷新 100+ 次 IPC）改为单次取回本地分组；批量静默写稿只刷新本章草稿列表并跳过文件树刷新。

### 优化（UI 流畅度）

**编辑器按键链路 —— 键入不再逐键把全文写进 store**

每次按键把整章内容写入 Zustand `tabs`，订阅方（EditorArea 整树）按键级重渲染，万字章节打字明显发滞。新增 `markTabDirty`（只翻标志、已 dirty 时零写入），内容由编辑器 ref 自持、保存/切 Tab 时刷回 store——切走再切回仍能看到未保存内容。字数回调加 300ms 节流。`DraftEditor` / `ProseEditorWrapper` / `ArchFileViewer` 三处统一。

**Agent 流式 —— 从每 token 全树重渲染降到每 80ms 一批**

Agent 流式没有节流（workflow 侧早有 120ms 节流），且多处整 store 订阅：每个 token 都会重渲染会话列表 + 输入框 + 标题栏，并对全文做 Markdown 重解析。改为：chunk 攒 80ms 批量落盘（终态前丢弃缓冲，防迟到定时器污染定稿文本）；六个组件全部改精确 selector；`AgentMessage` 加 memo（历史气泡不再陪跑）；流式期间 Markdown 段落纯文本渲染、`<think>` 折叠保留，格式化留到结束后一次完成；自动滚动从 smooth（动画互相打断抖动）改为即时定位。

**工作流流式扇出 —— 侧栏/工具条不再每秒 8 次空转**

`activeRuns` / `currentRun` 引用在流式期间约每 120ms 换一次，订阅整对象的组件全程陪跑。编辑器壳的"本章忙碌"、三个工具条的脉冲点、底部面板徽章全部折叠为布尔/数字 selector；侧栏树改订状态指纹字符串（流式 result 追加不再触发）；AI 输出面板步骤块加 memo，流式热路径的 6 处 `console.log` 移除。



本次围绕长篇连载的三处实际卡点：静态蓝图导致的逐章跑偏、无法用查找替换清理的中文标点、以及一直显示 0 的模型调用统计。

### 新增

**滚动蓝图 —— 按已写正文自适应刷新本章蓝图**（`431ccc6`）

章节蓝图是开写前一次性规划的，它从未见过真正写出来的正文。批量连写时直接消费这份过期蓝图，误差逐章累积，表现为「越写越飘」，只能逐章手工修蓝图。

- 写稿前插入刷新一步：把已定稿正文要点、上一章结尾、角色当前状态、未回收伏笔、反雷同样本、后续章节蓝图与节奏位置一并交给模型，产出修正后的本章蓝图，直接交给写稿命令
- 防跑偏：`role`（本章在主线中的功能定位）强制锚定为原值，模型无权改写全书结构；`userGuidance` 与已回填的章节要点原样保留
- 刷新失败一律降级为沿用原蓝图，绝不阻断批量
- 两个入口：批量生成对话框的开关（含独立模型槽与调用量估算），以及章节蓝图编辑器的「按进度刷新」。手动刷新一律先确认（覆盖手写字段且不可撤销），已定稿章节不显示该按钮
- 要点时间线改为一次取回全部蓝图，不再逐章 IPC 往返（原实现随连载推进线性变慢）

**标点规范化一键处理**（`5c6d814`、`e9b8066`、`6cd897a`、`3017e89`）

编辑器的字符串查找会做 Unicode NFKD 归一化，半角逗号 `U+002C` 与全角 `U+FF0C` 在该规则下等价，因此无法用查找替换区分并清理模型混入的半角标点；半角双引号更是无法用替换处理——中文引号需要交替产出左右形态。

- 草稿工具栏新增「标点」按钮，纯本地处理，不调用模型、不产生新版本
- 中文语境下的 `,` `;` `:` `!` `?` 转为全角；成对小括号在内含中文时转为全角；双引号按行配对转换（该行引号数为偶数才转，奇数计入跳过项）
- 清理全角标点后多余的空格
- 数字、西文、代码块、行内代码与 URL 一律跳过；半角句点与单引号刻意不处理，避免与小数点、省略号、文件名、英文撇号冲突
- 检测到但刻意未处理的项（无法配对的引号、中文语境半角句点）如实报告，不再出现「报告无事发生、正文里却仍有半角标点」
- 结果先弹三栏对比视图（与修稿合并同一套外观与交互），可按段落逐处取舍，确认后才写入
- 改动段落内做字符级高亮，直接标出变掉的那个标点；被删除的空格给最小宽度以便看见

### 修复

**模型调用统计始终为 0**（`315d930`）

统计的读取端一应俱全——`llm_calls` 表、仓库层、IPC 通道、面板组件，但没有任何地方写入：`db:log-llm-call` 在整个代码库里没有调用者，那张表从建库起就是空的。

- 在 `invokeLLMStreamOnce` 上报。该处是所有工作流 LLM 调用的唯一入口，一处覆盖写稿、审稿、去 AI 味、蓝图刷新与全部后处理步骤
- 失败的调用同样入账，否则报错的那些调用在统计里等于不存在
- `purpose` 取命令名，面板可看出 token 花在哪一步
- OpenAI 兼容渠道的流式此前既未索取也未解析 token 用量：请求补上 `stream_options.include_usage` 并解析末包用量；若服务商以 400 拒绝该字段，去掉它重试一次——收集统计绝不能让生成本身失败。静默忽略该字段的服务商按 0 记账，记录本身仍在

---

## 0.2.2

本次以「长篇连载中实际踩到的坑」为主线：角色改名会留下重复卡、定稿后处理被模型输出的非法 JSON 打断、以及中文正文里混入的半角标点无法用查找替换清理。

### 修复

**角色卡改名后产生重复卡**（`f4fba6a`）

`characters` 表以 `name` 作为主键，改名等于换了主键。保存时 `upsert` 走 `ON CONFLICT(name)`，库里找不到新名字便插入一条新记录，旧记录永久残留——每改一次名就多一张卡（角色列表 77 → 78）。store 内原有的 TODO 注释已记录该缺陷但未处理。

- `CharacterRepository` 新增 `rename`，原地 `UPDATE` 主键，整行迁移，动态状态与人设图路径一并保留
- 目标名已被占用时抛错而非覆盖，避免静默合并两张不同的卡
- 新增 `db:character-rename` 通道；store 为每张卡记录入库时的名字，`saveAll` 先改名再 upsert
- 删除改为按库中真实主键执行，兼容「已改名但尚未保存」的状态

**定稿后处理被模型返回的非法 JSON 打断**（`ecaf03d`、`8718f93`）

后处理各步骤共用的 `parseJSON` 只剥离 Markdown 围栏并截取最外层大括号，随后直接 `JSON.parse`。实际连载中撞到两种模型输出缺陷，均导致步骤耗尽重试后失败（第 6 章角色状态更新因此丢失）：

- 字符串值内出现未转义的换行或制表符 → `Bad control character in string literal`
- 用半角引号书写中文对白（如 `"他听见"梦魇之月"这个名字"`）提前闭合字符串 → `Expected ',' or '}' after property value`

改为修复链依次尝试：原样 → 转义控制字符 → 转义游离引号 → 两者叠加。合法 JSON 不受影响，确实无法修复的输入仍照常抛错，不会静默返回残缺数据。

### 新增

**标点规范化一键处理**（`5c6d814`）

编辑器的字符串查找会做 Unicode NFKD 归一化，半角逗号 `U+002C` 与全角 `U+FF0C` 在该规则下等价，因此作者无法用查找替换区分并清理模型混入的半角标点（须改用正则模式）。

- 草稿工具栏新增「标点」按钮，纯本地处理，不调用模型、不产生新版本
- 中文语境下的 `,` `;` `:` `!` `?` 转为全角，成对小括号在内含中文时转为全角
- 清理全角标点后多余的空格
- 数字、西文、代码块、行内代码与 URL 一律跳过；半角句点与引号刻意不处理，避免与小数点、省略号、文件名冲突
- 结果写入编辑器并标记未保存，可比对后再决定是否保存

---

## 0.2.1

本次以「写稿字数」为主线，修掉了一条从 UI 到提示词的断链，并补齐生图与设置面板的短板。

### 修复

**写稿字数远低于设定值**（`e11d8d9`）

提示词里字数原本是弱约束（「大约 N 字左右」），紧邻三条反注水指令（「切忌注水」「不要为了凑字数」「达成目标即立刻断章」），模型会系统性地朝下限偏离——实测目标 2500 字只产出 1100~1300 字。同时整条写稿链路对字数不做任何校验，短稿直接入库。

- `withWordNumber` 派生 `word_number_min` / `word_number_max`，模板改为硬性下限加目标区间
- 将「篇幅要求」与「内容边界」拆分表述，明确达标方式是把场景写厚而非把情节拉长；反注水改为只约束具体手段
- 写稿链路新增篇幅闸门：低于目标 90% 时自动发起续写补足，最多 2 轮，走续写而非重写以保住首轮文笔
- 字数统计改为忽略空白字符，编辑器与返回值统一使用最终稿（原先展示的是一致性修复前的版本）

**修稿越修越短**（`e4b42fd`）

修稿模板的篇幅条款是「目标字数约 N 字」配合「果断删减」「严禁无限扩写」，导致每轮修稿都在压缩篇幅。

- 改为：不得少于原稿字数，且不低于下限，并给出上限
- 允许删除啰嗦重复的句子，但删掉多少必须在同一处用更具体的动作、神态或感官细节补回
- 反注水拆为独立条款，只约束手段不约束长度

**创作对话框的「目标字数」从未生效**（`6205d3a`）

该字段只被写入创作历史记录，从未传入写稿流程，实际生效的一直是小说配置里的全局「每章字数」。

- `ChapterInfo` 新增 `wordsTarget`，对话框透传，写稿端优先使用本章覆盖值并回退全局配置
- 目标字数同时驱动提示词区间与篇幅闸门，并在日志中标明来源

**角色卡提取在长文本下整批失败**（`73d9f00`）

- 提取改为按字符数与条目数自动分批（`saveAll` 按名称 upsert，分批安全）
- 容错解析被截断的 JSON
- 提取失败不再静默，真实报错

### 新增

**全局美术风格与反向提示词**（`1232c65`）

- 小说配置新增「美术风格」与「反向提示词」，统一控制全书生图基调
- 角色卡新增「生图提示词」字段，可在全局风格之上补充角色专属描述
- 人设图支持手动上传，官方设定图等场景不必再依赖生成

### 其他

- 设置面板 i18n 补全：模型设置、向量与文生图模型配置的重复字段标签，以及缺失的取消按钮翻译（`0863e0f`、`32231ce`）
- 合并上游 i18n 相关提交（`0b244c6`）

---

## 历史归档

### PR #13「Vela Lite」修复

> 审计 + 修复 + 验证：5 个 patch 文件 + 23 个漏洞 + 72 个回归测试

#### 审计摘要

| 维度 | 数值 |
|------|------|
| 通读文件数 | 38 个 / ~8750 行 |
| 复现脚本 | 5 轮 / 24+ 个 case |
| 确认漏洞 | **23 个真实** |
| 误报 | 8 个（已剔除） |
| 严重度分布 | 🔴 P0 × 5，🟠 P1 × 8，🟢 P3 × 10 |
| Patch 文件 | 5 个 (~650 行) |
| 回归测试 | **+12 个** (从 33 → 45 → 72) |
| 性能提升 | **1.36x - 7.05x**（按输入规模） |
| IPC chatter 减少 | **85%**（40 → 6 calls per 5 章） |
| TypeScript | 0 错误 |
| ESLint（新增） | 0 错误（预存在错误已识别） |

#### 修复的 23 个漏洞

##### 🔴 P0（5 个）— 数据丢失 / 正确性崩溃

| # | 问题 | 文件:行 | 复现 |
|---|------|---------|------|
| 1 | `writeback` 非原子 → 章节 canon 数据丢失 | `canon-store.ts:142-200` | F4/F13 ✓ |
| 2 | `upsertCharacterState` knowledge 被覆盖而非 merge | `canon-repository.ts:155-194` | F1 ✓ |
| 3 | `deathSignals` 把单字 `死` 当死亡信号 → 成语误报 | `validator.ts:393-413` | F2v2 ✓（"死灰复燃"误报） |
| 4 | `stateSignals` 缺常见动词（飞/遁/跳/望/听） | `fact-extractor.ts:104-114` | F31 ✓ |
| 5 | fact-extractor 子串匹配导致 "林轩" 命中 "林轩雨" 段落 | `fact-extractor.ts:117-119` | F3v3 ✓ |

##### 🟠 P1（8 个）— 一致性逻辑绕过 / 静默失败

| # | 问题 | 文件 | 复现 |
|---|------|------|------|
| 6 | `safeParse` 静默吞 JSON 错（损坏数据假装正常） | `canon-repository.ts:43-46` | F6 ✓ |
| 7 | `addFact` dedup 字符串脆弱（大小写/空格绕过） | `canon-repository.ts:265-285` | F7 ✓ |
| 8 | `appendTimelineEvent` 缺 UNIQUE 约束（重复 sequence） | `canon-repository.ts:114-126` | F8 ✓ |
| 9 | 知识 substring bypass（"玉佩" 命中"那块玉佩的来历"） | `validator.ts:150-163` | F5/F23 |
| 10 | `tryAutoFix` 只修第一处 evidence | `auto-fix.ts:73-87` | F15/F28 ✓ |
| 11 | `fixLocationJump` 破坏章节结构（插入到标题行） | `auto-fix.ts:104-125` | F33 ✓ |
| 12 | `fixLocationJump` 假设性别（"他"） | `auto-fix.ts:122` | (dead code, but kept `charName`) |
| 13 | **Prompt injection via canon data**（LLM 写入 evidence 注入下一轮 prompt） | `context-builder.ts:99-101`, `prompt-builder.ts:35` | F12/F29 ✓ |

##### 🟢 P3（10 个）— 性能 / 设计选择

| # | 问题 | 文件 |
|---|------|------|
| 14 | 关系 fact regex 太严 | `fact-extractor.ts:196-198` |
| 15 | 上一章衔接检查噪音（2-4 字匹配太多） | `validator.ts:296-321` |
| 16 | `writeback` 跨 10+ IPC roundtrip | `canon-store.ts:142-200` |
| 17 | `db:canon-writeback-atomic` 缺类型声明 | `ipc-channels.ts:313`（**新加**） |
| 18 | `getProjectDb` 在非-Electron 环境静默失败 | `canon-store.ts:30-50` |
| 19 | `addPlotLine` dedup 字符串脆弱 | `canon-repository.ts:213-235` |
| 20 | `safeParse` 静默吐 `[]` 而非抛错 | `canon-repository.ts:43-46` |
| 21 | knowledge 列表被覆盖 | `canon-repository.ts:155-194` |
| 22 | fact-extractor evidence 超长未截断 | `fact-extractor.ts:177-205` |
| 23 | `canon_timeline_events.time_flow` 缺 CHECK 约束 | `database.ts` |

#### Patch 文件清单

```
patches/
├── 01-canon-repository.patch          # F1, F2, F6, F7, F8, F19, F20, F21, F22
├── 02-canon-store-atomic-writeback.patch  # F4, F13, F16
├── 03-validator-death-knowledge.patch  # F3, F9
├── 04-fact-extractor-state-signals.patch  # F5, F31
└── 05-autofix-and-context-escape.patch  # F10, F11, F12, F13, F28
```

## 新增的测试

### 回归测试套件（防止 bug 复发）

`src/services/narrative-consistency/__tests__/narrative-consistency.test.ts` 新增 12 个 `describe('回归测试：审计发现的 bug 修复验证')` 块：

- F1: knowledge merge（union + dedup）
- F2: 死灰复燃/视死如归 等成语不触发"复活"
- F4/F13: writeback 必须用 `db:canon-writeback-atomic`
- F6: corrupt JSON 必须抛错
- F7: addFact 规范化去重（大小写/空格不敏感）
- F8: timeline sequence ON CONFLICT（覆盖而非重复）
- F12/F29: prompt builder 转义 `{{}}`
- F15/F28: tryAutoFix 处理所有 occurrence
- F18: 多个 issues 同样 evidence 都触发插入
- F31: stateSignals 包含"飞"
- F33: fixLocationJump 不破坏标题
- F33b: fixLocationJump 在 narrative line 上正常工作

### IPC 校验测试（DoS 防护）

`electron/__tests__/ipc-validation.test.ts` 新增 24 个 case：

- 字符串长度限制（防止 1GB string）
- 数字范围
- 枚举值校验
- 数组长度限制
- 嵌套 payload 校验
- `safeValidate` 包装器测试

### 性能回归测试（防止优化退化）

`src/services/narrative-consistency/__tests__/perf-regression.test.ts` 新增 3 个 case：

- 10K chars + 20 chars: < 10ms
- 20K chars + 50 chars: < 30ms
- 200 章节批量: < 200ms

## 新增的模块

### `electron/ipc-validation.ts`

主进程入口的统一校验层，**防止**：
- DoS via 巨型 string（1GB statement 直接落 SQLite）
- Type confusion（renderer 发错字段类型）
- Data corruption（type 不在 enum 内）

提供 8 个具体 validator：
- `validateCanonTimelineEventInput`
- `validateCanonFactInput`
- `validateCanonPlotLineInput`
- `validateCanonCharacterStateSnapshot`
- `validateCanonChapterSummary`
- `validateCanonWritebackPayload`
- `validateCanonTimelineEvent`
- `safeValidate` 包装器

每个 validator 检查：
- 类型
- 长度上限（statement 500 字、name 200 字、list 1000 等）
- 枚举值（VALID_CATEGORIES, VALID_TIMEFLOW, VALID_PLOT_STATUS）
- 必需字段

## 数据库 schema 变更

`electron/database.ts` 新增：
- `migrateProjectDatabase()` 函数：迁移老库，加 UNIQUE 索引
- `idx_canon_timeline_unique` on `(chapter_number, sequence)`
- `idx_canon_facts_unique` on `statement COLLATE NOCASE`
- `idx_canon_plot_unique` on `name COLLATE NOCASE`
- `user_version` PRAGMA 跟踪 schema 版本（当前 v1）

迁移逻辑：清理重复数据 → 建索引 → 幂等（重跑安全）

## IPC 类型声明补全

`src/shared/ipc-channels.ts` 新增：
- `db:canon-writeback-atomic` 频道类型
- `CanonWritebackPayload` 接口（与主进程 `writebackAtomically` 入参兼容）
- 所有字段都有精确类型（避免 `any`）

## 性能对比

### 真实中文章节（939 chars, 3 characters）

| 组件 | 原版 | 修复后 | 加速 |
|------|------|--------|------|
| `validateChapter` | 0.15ms | 0.11ms | 1.36x |
| `runConsistencyGate` | 0.14ms | 0.12ms | 1.17x |

### 合成大数据

| 规模 | 原版 | 修复后 | 加速 |
|------|------|--------|------|
| 2K chars, 5 chars | 0.30ms | 0.08ms | 3.56x |
| 5K chars, 10 chars | 1.15ms | 0.26ms | 4.35x |
| 10K chars, 20 chars | 2.77ms | 0.70ms | 3.94x |
| **20K chars, 50 chars** | **11.66ms** | **1.65ms** | **7.05x** |

### 200 章书

- 校验 200 章: 34ms (0.17ms/chapter)
- 写回 200 章: 1ms (400 IPC, 2/chapter)
- 插入 10K facts: 257ms (0.027ms/fact)

## 自动化验证

新增 `ci-validate.sh`：单条命令跑完整套 CI

```bash
./ci-validate.sh
```

10 个 step：
1. TypeScript compile
2. Vitest unit tests (72)
3. Self-contained tests (24)
4. Demo e2e
5. Terminal demo
6. Patch verification (14)
7. Adversarial round 1
8. Realistic Chinese benchmark
9. Stress test (200 chapters, 10K facts)
10. ESLint (patched files)

## 文件清单

```
src/services/narrative-consistency/
├── __tests__/
│   ├── narrative-consistency.test.ts  (45 tests, +12 regression)
│   └── perf-regression.test.ts        (3 perf tests, NEW)
├── canon-store.ts                     (writeback atomic)
├── validator.ts                       (deathSignals + knowledgeMatch)
├── auto-fix.ts                        (fixAll + structure)
├── fact-extractor.ts                  (stateSignals + boundary)
└── context-builder.ts                 (escape + slice)

electron/
├── ipc-validation.ts                  (NEW: zod-style validators)
├── __tests__/
│   └── ipc-validation.test.ts         (24 tests, NEW)
├── database.ts                        (migrateProjectDatabase)
├── repositories/canon-repository.ts   (writebackAtomically + merge + UNIQUE)
└── controllers/db-controller.ts       (apply validators to all canon handlers)

patches/
├── 01-canon-repository.patch
├── 02-canon-store-atomic-writeback.patch
├── 03-validator-death-knowledge.patch
├── 04-fact-extractor-state-signals.patch
└── 05-autofix-and-context-escape.patch

ci-validate.sh                          (10-step CI)
adversarial-verify*.mjs                 (4 rounds of reproducers)
verify-patches.mjs                      (14 patch verifications)
realistic-benchmark.mjs                 (realistic perf)
stress-test.mjs                         (200-chapter stress)
CHANGELOG.md                            (this file)
```

## 仍未修的问题（按设计 / 低优先级）

| 问题 | 决策 |
|------|------|
| location check 只对已知角色 | 设计选择（需要先在 canon store 登记） |
| buildCanonContext 拉全量 IPC 数据 | IPC 限制；更优解改 SQL |
| `run-standalone.mjs` setup 错误 | 预存在，非我引入 |
| `stability-controller.service.ts` 3 个未用参数 | 预存在 |
| `auto-fix.ts:buildReport._originalContent` 未用 | 预存在 |

## 还能做的事（未来工作）

1. 把 `knowledgeMatch` 升级为基于 embedding 的语义相似度
2. 把 `stateSignals` 升级为基于 POS tagging 的抽取
3. 把 IPC validators 提取到共享包，让 renderer 端也能用
4. 加 LLM 输出的 audit（生成内容 vs canon 的一致性评分）
5. 加 `ncu` 性能 profiling（CUDA-style timeline）
