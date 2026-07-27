# Windows 发行版打包踩坑记录（rcedit "Unable to commit changes"）

记录时间：2026-07-27，首次触发版本：0.2.1（electron-builder 26.8.1 / Electron 41.2.0 / Windows 11 22631 x64）

## 1. 症状

`electron-builder` 打 Windows 包时，前面所有阶段（rebuild 原生依赖、asar 打包、写入 asar 完整性资源）都成功，最后卡在给主 exe 写版本信息和图标这一步，重试 4 次全失败，进程以 `exit code 1` 结束：

```
• updating asar integrity executable resource  executablePath=release\0.2.1\win-unpacked\Vela.exe
⨯ cannot execute  cause=exit status 1
                  errorOut=Fatal error: Unable to commit changes

                  command='...\winCodeSign-2.6.0\rcedit-x64.exe' '...\win-unpacked\Vela.exe'
                    --set-version-string FileDescription Vela ... --set-icon '...\build\icon.ico'
```

结果：`release/<version>/` 只有 `builder-debug.yml` 和 `win-unpacked/`，**nsis 和 portable 目标根本没进入打包阶段**，拿不到 setup/portable 安装包。

## 2. 根因

**rcedit 写完这个 ~212 MB 的 exe 之后，文件会被短暂占用（最可能是杀毒软件实时防护在扫描刚落盘的大文件），而 electron-builder 的 4 次重试间隔太短，全部撞在这个占用窗口里。**

与图标文件内容无关，与 exe 内容无关。

### 2.1 证据

对同一个 `win-unpacked\Vela.exe` 连续调用 rcedit：

| 顺序 | 操作 | 结果 |
|---|---|---|
| A | 只写版本信息（不动图标） | `status=0` |
| B | `--set-icon icon.ico`（390 KB / 6 条目） | `status=0` |
| C | `--set-icon` 同一个文件，紧接着再来一次 | `Unable to commit changes` |
| D | `--set-icon` 另一个 32 KB 的精简图标 | `Unable to commit changes` |
| E | `--set-icon` 原始 661 KB 图标 | `Unable to commit changes` |
| F | 版本信息 + 图标（复现 electron-builder 的完整命令行） | `Unable to commit changes` |

**第一次写成功，之后连续写全部失败，且与图标大小/条目构成无关。**

再把间隔拉到 15 秒，同一条 `--set-icon` 命令连跑 5 次：

```
attempt 1 status=0 ms=717
attempt 2 status=0 ms=716
attempt 3 status=0 ms=873
attempt 4 status=0 ms=2529
attempt 5 status=0 ms=926
```

**5/5 全部成功。** 结论确定：是时序/文件占用问题，不是内容问题。

### 2.2 曾经的误判（不要再走一遍）

第一次排查时，用 `resedit` 解析 `build/icon.ico` 发现里面有一个 256×256 的**未压缩 BMP** 条目（约 270 KB，整个 ico 661 KB），当时得出结论「rcedit 无法把这么大的资源提交进 PE」，于是重建了一个去掉该条目的精简 ico。

**这个结论是错的。** 它建立在一次顺序有偏差的隔离测试上（恰好"原图在前、精简图在后"，而真实规律是"第一次成功、后续失败"）。换成精简 ico 之后第三次打包仍然以完全相同的方式失败。

同样被排除的假设：
- exe 被占用/正在运行 —— 打包前后都确认过没有 `Vela.exe` 在跑，且 `fs.openSync(exe, 'r+')` 能成功打开。
- rcedit 二进制损坏 —— 同一个 rcedit 在有间隔的情况下 100% 成功。

## 3. 可用的绕法（0.2.1 就是这么出的包）

思路：**自己把 exe 资源改好，然后让 electron-builder 跳过会失败的那一步。**

`--prepackaged` 会直接以给定目录作为 `appOutDir` 进入目标打包阶段，完全跳过 pack（也就跳过了 rcedit 调用）。

```bat
:: 1) 先正常构建，产出 win-unpacked（这一步会在 rcedit 处失败，退出码非 0，忽略即可）
node node_modules\typescript\bin\tsc -p tsconfig.json
node node_modules\vite\bin\vite.js build
node node_modules\electron-builder\out\cli\cli.js

:: 2) 手动补写版本信息和图标，每次调用之间留 15 秒
::    rcedit 路径：
::    %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe
::    先只写版本信息，等待，再写 --set-icon build\icon.ico

:: 3) 跳过 pack，直接打 nsis + portable
node node_modules\electron-builder\out\cli\cli.js --prepackaged "release\0.2.1\win-unpacked" --win
```

### 3.1 为什么不用其他绕法

- `"signAndEditExecutable": false`：能让打包通过，但主 exe 会丢掉自定义图标和版本信息，用户看到的是默认 Electron 图标。不可接受。
- 只是反复重删 `release/<version>` 重跑：失败是稳定复现的（3/3），无效。
- 换精简图标：基于错误的根因，无效（见 2.2）。

## 4. 用 `--prepackaged` 时必须验证的两件事

`--prepackaged` 跳过了整个 pack 阶段，所以要确认 pack 阶段该做的事已经做完，尤其是 asar 完整性。

**结论：asar 完整性资源在 rcedit 失败之前就已经写好了**，日志里 `updating asar integrity executable resource` 那一行是 electron-builder 用 `resedit` 在进程内完成的，成功；失败的只是紧随其后的 rcedit 调用。所以 `win-unpacked` 除了图标和版本信息之外是完整的。

验证方法（0.2.1 实测通过）：

1. **完整性 hash 比对** —— 读出 exe 里名为 `ELECTRONASAR` 的 `INTEGRITY` 资源，和 `@electron/asar` 的 `getRawHeader(app.asar).headerString` 的 SHA256 比对，必须一致。

   ```
   INTEGRITY_RAW  [{"file":"resources\\app.asar","alg":"SHA256","value":"225edf5a...5ec1"}]
   ASAR_HEADER_SHA256                                                    225edf5a...5ec1
   ```

   顺带一提，`@electron/fuses` 读出的 fuse wire 显示 `EnableEmbeddedAsarIntegrityValidation` 当前是**关闭**的，所以即使不一致也不会在运行期报错——正因如此，**不能靠"能启动"来判断完整性资源是否正确，必须做 hash 比对。**

2. **资源清点** —— 用 `resedit` 列出资源类型，确认图标和版本信息真的写进去了：

   ```
   RES_TYPES {"1":23,"3":6,"12":21,"14":1,"16":1,"24":1,"INTEGRITY":1}
   RT_ICON=6  RT_GROUP_ICON=1  RT_VERSION=1
   ```

   再用 `rcedit --get-version-string ProductName / FileDescription / CompanyName / LegalCopyright` 逐项读回。

3. **启动冒烟** —— 直接跑 `win-unpacked\Vela.exe`，带 `ELECTRON_ENABLE_LOGGING=1` 抓 stdout/stderr，存活 30 秒后用 `tasklist` 确认进程数（主进程 + renderer + GPU + utility，正常是 4 个），stderr 应为空、不应提前退出。测完只 kill 自己启动的那个 PID 树，别按镜像名杀，免得干掉用户正在用的 Vela。

## 5. 建议的根治办法（尚未实施）

按优先级：

1. **加杀软排除项**：项目目录 + `%LOCALAPPDATA%\electron-builder\Cache`。这是真正的根治，但要改开发机系统设置。
2. **把两阶段流程固化成 `build:win` 脚本**：`tsc → vite build → electron-builder（容忍 rcedit 失败）→ 带间隔重试补写资源 → electron-builder --prepackaged`。环境改不了时用这个。
3. 长期可考虑给 electron-builder 提 issue，让 rcedit 的重试带指数退避（目前 4 次重试太密）。

## 6. 本机环境的额外注意事项

排查期间踩到的与打包无关但会拖慢定位速度的问题，一并记下：

- 直接执行 shell 命令极不稳定：回显逐字重复、退出码恒为 -1/1、`Start-Sleep` 实际不生效。**可靠做法是把命令写进 `.bat`，用 `cmd /c xxx.bat` 跑，并把输出重定向到日志文件，再读文件。** 结尾追加 `echo ALL_DONE` 之类的哨兵行来判断是否跑完。
- PowerShell 执行策略禁用了 `pnpm.ps1`，必须直接调 node：`node node_modules\electron-builder\out\cli\cli.js`。
- 本项目 `package.json` 是 ESM，临时诊断脚本必须用 `.cjs` 扩展名。
- 排查脚本会往仓库根目录扔一堆临时文件（`*.log` / `*.txt` / `*.bat` / `*.cjs`），收尾时记得清干净；改动过的 `build/icon.ico` 之类资源也要还原。

## 7. 0.2.1 实际产物

```
release/0.2.1/
  Vela-0.2.1-setup.exe             224.9 MB
  Vela-0.2.1-setup.exe.blockmap
  Vela-0.2.1-portable.exe          224.4 MB
  latest.yml
  win-unpacked/
```
