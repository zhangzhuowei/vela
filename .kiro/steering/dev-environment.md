---
inclusion: always
---

# Vela 开发环境与验证（踩坑记录 · 务必先读）

> 本文件记录 Vela 实际开发中反复踩到的坑与固定解法，目的是**减少重试、少走弯路**。
> 改代码、跑构建前先扫一遍本节。项目完整开发规范见根目录 `rule.md`。

## 1. 本机环境限制

- 系统：**Windows / PowerShell**（即使标称 cmd，实际走 PowerShell）。
- **没有 MSVC / Visual Studio**：不能本地编译原生模块。`better-sqlite3`、`@lancedb/lancedb` 全靠 **prebuild 预编译二进制**（匹配当前 Electron 版本的 ABI）。
  - 不要指望 `electron-rebuild` 能本地重编；**不要引入需要本地编译的原生依赖**。
- 包管理器：**pnpm**（经 corepack）。

## 2. 终端极不稳定（本项目最大时间黑洞）

- 终端执行会**逐字符回显**命令、**退出码几乎总是 1（不可信）**、重定向产生的文件**有延迟**、有时整个 shell **彻底卡死**（连 `echo > probe.txt` 都不产文件）。
- **铁律：不要依赖 stdout / exit code。** 一律把输出重定向到 `.log` 文件 → sleep → **读该文件**判断结果，用自加的 `DONE_EXIT_0` 作为成功标记。
- PowerShell 下**直接跑 `pnpm` 会被执行策略拦截**（`pnpm.ps1` UnauthorizedAccess）→ **必须用 `cmd /c "pnpm ..."` 包一层**。
- 标准命令模板：

  ```
  cmd /c "echo START > x.log & pnpm exec <命令> >> x.log 2>&1 & echo DONE_EXIT_%errorlevel% >> x.log"
  ```

- **工作目录会丢失（重要）**：flaky 终端常把 cwd 漂到工作区父目录（如 `.../novelai` 而非 `.../novelai/vela`），导致 `pnpm exec` 报 `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE  No package found in this workspace`、日志也写错目录。**不要依赖工具的 cwd 参数**——在命令里用 `cd /d` 强制切到项目根，并对日志用绝对路径：

  ```
  cmd /c "cd /d e:\<项目绝对路径>\vela & echo START > x.log & pnpm exec <命令> >> x.log 2>&1 & echo DONE_EXIT_%errorlevel% >> x.log"
  ```

  读日志时也用绝对路径确认；若发现日志跑到了父目录，就是 cwd 漂了，改用上面的 `cd /d` 写法重跑。

- **卡死恢复顺序**：① 停掉所有卡住的后台进程；② 起一个**全新**后台进程（`cmd /c` 包装）跑；③ 若后台进程也不产出，回退到普通 shell 的 `cmd /c` 方式重试。经验：一次构建常需 **2–4 次尝试**才产出日志，这是环境问题、**不是代码问题，别改代码**。
- `tsc` 相对稳（一次过，约 140s）；`vite build` 更易卡，提前做好重试准备。

## 3. 验证流程（每次改完必做）

1. **类型检查**：`pnpm exec tsc -p tsconfig.json`（覆盖 `src/` + `electron/` 全量 TS）。
2. **打包验证**：`pnpm exec vite build`（分别产出 renderer `dist/` + `dist-electron/main.js` + `preload.mjs`）。
   - **只要动了 `electron/` 下的代码，必须跑 `vite build`** 确认 `main.js` 能打包成功——`tsc` 只验类型，不验打包 / 动态 `import()`。
3. 两步都 `DONE_EXIT_0` 才算绿。验证完**删除临时 `.log`**。

## 4. 控制台中文乱码 ≠ 报错

- 主进程 `console.log` 的中文在默认代码页（GBK 936）下会显示成乱码（如 `[Vela DB] 枦伧Ⅲ铸氩负...`），这是**终端编码问题，不是错误**。切 UTF-8：`chcp 65001`，或改用 VS Code 内置终端 / Windows Terminal。

## 5. 数据库与迁移（加列必看）

- 数据分两处：**SQLite `.vela/vela.db`**（小说配置 / 章节 / 草稿 / 角色卡 / 伏笔）与 **LanceDB `.vela/lancedb`**（知识库向量）。两者独立，换 Embedding 模型只影响后者。
- `CREATE TABLE IF NOT EXISTS` **不会**给已存在的表补列。**新增列必须走 `electron/database.ts` 的 `migrateSchema()`**：`PRAGMA table_info(表)` 检查后 `ALTER TABLE 表 ADD COLUMN ...`（幂等、每次打开项目都执行）。迁移日志只在**真正补列时**才打印，没打印 ≠ 失败。
- 改了 `electron/`（含 DB）要**重启 `pnpm dev`** 才生效；旧项目库在下次打开时自动补列，数据不丢。
- 需要改写已有数据的迁移（去重、改约束等）追加到 `database.ts` 的 `MIGRATIONS` 数组末尾：每步一个事务、成功才升 `user_version`，执行前自动整库备份；库版本高于应用时拒绝打开。**只新增表**用 `CREATE TABLE IF NOT EXISTS` 即可，不要为此升 `SCHEMA_VERSION`（升了之后旧版 Vela 会拒绝打开该项目）。

## 6. 给「共享类型」加字段：一律用可选（`?`）

- 给 `CharacterData` / `CharacterStateData` / `NovelConfig` 这类**被多处对象字面量构造**的类型加字段时，**设为可选** `field?: T`。否则 finalize / import 里那些不带该字段的 `db:*-upsert` 调用会全部编译报错。仓库 `rowToData` 读取时用 `(row.x as string) ?? ''` 兜底，写入用 `data.x ?? ''`。

## 7. prompt-builder 注入槽位

- `ChapterPromptBuilder.build()`：**未 `set` 的 `{{var}}` 会原样留在最终 prompt 里并告警**。新增注入槽后，务必在**所有调用链**上都 set（内容为空时给占位文案，如"（暂无）"），不能只在部分路径 set。

## 8. 向量维度（Embedding 兼容）

- 向量列维度**不可写死**（历史 bug：写死 2048 = 只有智谱 `embedding-3` 能用，硅基流动 bge-m3=1024 / bce=768 等全部报维度不匹配）。现已改为**按模型实际输出动态建表**（见 `electron/vector-store.ts`：`firstVectorDim` / `schemaVectorDim` / `buildChunkSchema`）。
- 换模型导致维度变化时会**重建向量表并丢弃旧向量**（正文保留），需在知识库界面重新"回填 / 重建向量索引"。
- 配硅基流动向量模型：协议 `openai`，baseUrl `https://api.siliconflow.cn/v1`，模型名如 `BAAI/bge-m3`。设置里"测试连接"成功会回显实际维度。

## 9. 依赖与二进制导出

- **尽量不 `pnpm add`**（终端不稳，装依赖 / 触发原生编译风险高）。确需装时优先**纯 JS 包**并 **pin 版本**。
- EPUB 导出即用零依赖方案：`electron/utils/epub-builder.ts` 用内置 `zlib` deflate + 自实现 CRC32 手写 ZIP（`mimetype` 必须首个且 STORED）。二进制文件在**主进程**构建后 `fsPromises.writeFile` 写盘，不经渲染层。

## 10. 批量管线静默

- 批量 / 无人值守命令通过 `silent` 参数避免每章刷编辑器 tab（`GenerateDraftCommand` 第三参、`AutoReviewLoopParams.silent`、`DeaifyParams.silent` 均支持）。单章交互路径默认**不**静默，照常开 tab。

## 11. 其它易踩点

- "写作第 X 章"按钮依赖**该章已有蓝图**；无蓝图时应提示先生成蓝图，而非静默无反应。
- 全局弹窗一律走 `layout-store`（如 `openExport()`），禁用 `window` 事件总线。

## 12. 打包 exe（electron-builder · rcedit 锁坑）

- 打包命令：`pnpm run build`（= `tsc && vite build && electron-builder`）。产物在 `release/<version>/`：`Vela-<ver>-setup.exe`（nsis）、`Vela-<ver>-portable.exe`（portable）、`win-unpacked/`。升级版本号只改 `package.json` 的 `version`。
- **本机反复踩的坑**：electron-builder 生成 ~220MB 的 `Vela.exe` 后**立即**调用 `rcedit-x64.exe` 写图标/版本信息，此刻文件句柄未释放（本机 Defender 实时防护已关，仍复现，判定为句柄竞争/第三方安全软件），rcedit 连续 4 次报 `Fatal error: Unable to commit changes` → 整个 build 失败。**这与源码改动无关**：我们的改动都进 `app.asar`，进不了被 rcedit 编辑的 Electron 二进制。
  - 验证方法：把已存在的旧 `Vela.exe` 复制一份，手动跑同样的 `rcedit ... --set-icon ...`，**会成功**（文件已冷却）。证明 rcedit 与图标文件都正常，纯粹是"刚落盘即写"的时机锁。
- **稳定出包的三步法（保留图标+版本，不动杀软）**：
  1. `electron-builder.json5` 的 `win` 临时加 `"signAndEditExecutable": false` → 跑 `pnpm exec electron-builder --dir`，只出 `win-unpacked`（跳过内联 rcedit，`EXITCODE=0`）。
  2. 对落盘后的 `release/<ver>/win-unpacked/Vela.exe` **手动** rcedit（PowerShell `&` 调用，路径用绝对路径）：
     `& '<winCodeSign缓存>\rcedit-x64.exe' '<...>\win-unpacked\Vela.exe' --set-icon '<...>\build\icon.ico' --set-file-version '<ver>' --set-product-version '<ver>.0' --set-version-string ProductName Vela ...`（rcedit 在冷却文件上 `EXIT=0`）。
  3. `pnpm exec electron-builder --prepackaged release/<ver>/win-unpacked` → 从已打好品牌的目录直接产出 nsis + portable（不再 rcedit）。
  4. 完事把 `signAndEditExecutable` 从配置里去掉，保持仓库配置干净。
- rcedit 路径无空格，可不加引号；**但绝不能在 `cmd /c "..."` 里再对它套双引号**（会提前截断外层引号，报"文件名/目录名语法不正确"，errorlevel 123）。带空格的值（如 LegalCopyright）用 PowerShell `&` 调用+单引号最稳，`©` 等字符改用 `(c)` 避免编码乱码。
- `cmd /c "... & ..."` 里的 `%errorlevel%` 在解析期就被展开，**拿不到 pnpm 真实退出码**；要可信退出码用 `cmd /v:on /c "... & echo EXIT=!errorlevel!"`（延迟展开），或直接看日志里的 `ELIFECYCLE` / electron-builder 报错行。

## 13. 单元测试（vitest）

- 测试框架是 **vitest**，`environment: 'node'`，`globals: false`（所以每个测试文件都要 `import { describe, it, expect } from 'vitest'`）。跑测试用 `pnpm run test`（= `vitest run`；PowerShell 下仍需 `cmd /c` 包装 + 日志文件判断，见第 2 节）。
- `vitest.config.ts` 按 glob 收集 `src/**/__tests__/**/*.test.ts` 与 `electron/**/__tests__/**/*.test.ts`，新测试放对位置即自动纳入；`standalone.test.ts`（node:assert 脚本式）在 `exclude` 里。
- **本机 SQLite 相关测试会失败**：`node_modules` 里的 better-sqlite3 是按 Electron ABI 编译的，用 Node 跑会报 `NODE_MODULE_VERSION` 不匹配——这是环境问题，不是代码问题。CI（`.github/workflows/ci.yml`）按 Node 安装依赖，可正常跑。本机要全量跑通，用 Electron 充当 Node：`cmd /v:on /c "cd /d E:\...\vela& set ELECTRON_RUN_AS_NODE=1& node_modules\electron\dist\electron.exe node_modules\vitest\vitest.mjs run > tmp\vitest.log 2>&1& echo VITEST_EXIT=!errorlevel!>> tmp\vitest.log"`（`set X=1&` 之间不要留空格，也不要写成 `set "X=1"`，否则破坏外层引号）。
- **工作目录的盘符必须大写**（`cd /d E:\...`）：盘符小写（`e:\`）时，vitest 的**相对路径** `vi.mock('../xxx')` 会**静默失效**（加载的仍是真实模块），裸模块名（`vi.mock('electron')`）不受影响。
- **测试不能碰真实的 `~/.vela`**：需要读写配置/记录文件的模块，把文件路径做成可注入参数（参考 `electron/mcp/mcp-approval.ts` 的 `createMcpApprover`），测试里传 `os.tmpdir()` 下的临时路径，不要依赖 mock `config-utils` 的 `VELA_HOME`。
- CI 每次 push / PR 跑 `typecheck` + `lint`（`--max-warnings 0`）+ `test`，锁文件用 `--frozen-lockfile`：改依赖必须同时提交更新后的 `pnpm-lock.yaml`。
- 测试就近放同级 `__tests__/`，命名 `*.test.ts`。语言包/JSON 这类可直接 `import x from '../locales/xx.json'` 做结构断言（参考 `src/i18n/__tests__/i18n.test.ts`）。
- 纯函数（如 `src/services/workflows/json-repair.ts` 的容错解析）适合直接单测，不需要 DOM/Electron。

## 14. 长命令（tsc / vite build / vitest）优先用后台进程轮询

- 经验补充：用 `node 脚本.cjs` 里 `execSync('node node_modules/typescript/bin/tsc ...')` 时，外层执行会**提前拿回控制权**，而 node+tsc 其实还在后台跑——结果文件只停在预写的 `STARTED`，读不到真正结果，误判成失败。
- 更稳的做法：**起后台进程**跑长命令，命令尾部自带成功标记（如 `; echo TSC_EXIT=$LASTEXITCODE`），再**轮询进程输出**，看到 `TSC_EXIT=0`（或 vitest 的 `passed`）才算过。tsc 全量约 140s，耐心轮询；没输出 ≠ 失败，别急着改代码。
- 跑完记得停掉后台进程、删除临时脚本/日志。

## 15. Vite 配置与 CSP

- Vite 查找配置文件时 **`vite.config.js` 优先于 `vite.config.ts`**。`tsc -b` 以前会把 `tsconfig.node.json` 编译出的 `vite.config.js` / `.d.ts` 放在根目录，导致改了 `vite.config.ts` 却不生效；现已把 `tsconfig.node.json` 的 `outDir` 指到 `node_modules/.tmp/`。根目录若又出现 `vite.config.js`，直接删掉。
- 生产构建会由 `vite.config.ts` 里的 `contentSecurityPolicy()` 插件往 `index.html` 注入 CSP（`script-src 'self'`，不允许内联脚本 / 远程脚本 / eval，`connect-src 'self'`）。开发模式不注入。
- 因此 **`index.html` 里不能再写内联 `<script>`**：需要在首屏前执行的脚本放到 `public/` 下用 `<script src>` 引用（参考 `public/theme-boot.js`）。渲染进程也不要直接 `fetch` 外部地址，网络请求一律走主进程 IPC。

## 16. 界面结构与界面冒烟

- 左侧工具栏实际挂载的是 **`LeftToolWindowBar.tsx`**（见 `App.tsx`）；`ActivityBar.tsx` 没有任何地方引用，入口别加在那里。项目级操作（新建 / 打开 / 导出 / 备份）在主页侧栏 `HomeSidebarPanel.tsx` 和欢迎页。
- 新增侧栏视图：`layout-store` 的 `SidebarView` 联合类型 → `Sidebar.tsx`（标题 + 分支；自己管理滚动区的视图加进 `selfScrolling`）→ `LeftToolWindowBar.tsx` 按钮 → 三语 i18n（panels `sidebar.*`、layout `activityBar.*`）。
- 打开某份章节稿子用 `SidebarShared` 的 `resolveDraftTab` / `openDraftTab`：定稿走 `vela://manuscript/{id}`，其余走 `vela://draft/{id}`（草稿编辑器），同一份稿子已用任一路径打开就复用。要在编辑器里定位并高亮某段文字，先 `requestEditorReveal`（`src/services/editor-reveal.ts`）再开 Tab；偏移按换行统一为 `\n` 后的正文计算。
- 界面冒烟可以不开可见窗口：脚本里先把 `USERPROFILE` / `APPDATA` 指到临时目录并 `app.setPath('home' | 'appData' | 'userData', 临时目录)`，再 `import()` 真实的 `dist-electron/main.js`，在 `browser-window-created` 里把窗口移到屏幕外、透明、不可聚焦，然后用 `webContents.executeJavaScript` 经 `window.velaAPI` 建项目灌数据、点界面。这样不会碰真实的 `~/.vela`。
- 屏幕外 / 隐藏的窗口里 **`requestAnimationFrame` 不触发**：Toast（`show()` 用 rAF 挂载）在冒烟里看不到属正常；业务逻辑不要用 rAF 延迟执行，否则窗口在后台时也会卡住（编辑器定位就是因此改成 `setTimeout(0)`）。
