/**
 * 用 Electron 内置 Node 跑 vitest。
 *
 * better-sqlite3 按 Electron ABI 编译（应用运行必需），普通 Node 加载不了；
 * ELECTRON_RUN_AS_NODE=1 让测试与应用共用同一个 ABI，SQLite 持久化测试才能过。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')

const result = spawnSync(
  electron,
  ['node_modules/vitest/vitest.mjs', ...(process.argv.length > 2 ? process.argv.slice(2) : ['run'])],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }
)
process.exit(result.status ?? 1)
