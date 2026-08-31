/**
 * 本地 Windows 应急打包（绕过 rcedit "Unable to commit changes" 竞态）
 *
 * 背景见 docs/build/windows-release-packaging.md：杀软实时防护锁定刚落盘的大 exe，
 * electron-builder 内建的 4 次 rcedit 重试间隔太密，全部撞在占用窗口里。
 *
 * 正式发行请走 CI（推 v* tag 触发 GitHub Actions）。本脚本仅供本地应急/快速验证。
 *
 * 流程：tsc → vite build → electron-builder（pack 到 win-unpacked，容忍 rcedit 失败）
 *      → 带间隔重试手动补写版本信息与图标 → electron-builder --prepackaged 出安装包。
 *
 * 用法：node scripts/build-win-local.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
const version = pkg.version
const unpacked = path.join(root, 'release', version, 'win-unpacked')
const exe = path.join(unpacked, 'Vela.exe')
const icon = path.join(root, 'build', 'icon.ico')
const rcedit = path.join(
  process.env.LOCALAPPDATA ?? '',
  'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe'
)

const node = process.execPath
const run = (args, opts = {}) =>
  spawnSync(node, args, { cwd: root, stdio: 'inherit', ...opts }).status ?? 1
const sleep = (ms) => spawnSync(node, ['-e', `setTimeout(()=>{}, ${ms})`], { stdio: 'ignore' })

console.log('[1/4] tsc')
if (run([path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'])) {
  console.error('tsc 失败，终止'); process.exit(1)
}

console.log('[2/4] vite build')
if (run([path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'])) {
  console.error('vite build 失败，终止'); process.exit(1)
}

console.log('[3/4] electron-builder pack（rcedit 失败可忽略）')
run([path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js')])
if (!existsSync(exe)) {
  console.error(`未产出 ${exe}，终止`); process.exit(1)
}

console.log('[3.5] 手动补写版本信息与图标（带间隔重试）')
if (!existsSync(rcedit)) {
  console.error(`找不到 rcedit：${rcedit}\n先跑一次官方 pnpm build 让 electron-builder 下载 winCodeSign 缓存。`)
  process.exit(1)
}
const rceditArgs = [
  exe,
  '--set-version-string', 'FileDescription', 'Vela',
  '--set-version-string', 'ProductName', 'Vela',
  '--set-version-string', 'InternalName', 'Vela',
  '--set-version-string', 'CompanyName', 'heider',
  '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 heider',
  '--set-file-version', version,
  '--set-product-version', `${version}.0`,
  '--set-icon', icon,
]
let ok = false
for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
  const status = spawnSync(rcedit, rceditArgs, { stdio: 'inherit' }).status
  if (status === 0) { ok = true; break }
  console.warn(`rcedit 第 ${attempt} 次失败（多半是杀软瞬时锁），等 15 秒重试…`)
  sleep(15000)
}
if (!ok) {
  console.error('rcedit 5 次全失败。建议：给 release 目录与 electron-builder 缓存加杀软排除项后重试。')
  process.exit(1)
}

console.log('[4/4] electron-builder --prepackaged 出安装包（跳过 pack/rcedit）')
if (run([path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', '--prepackaged', unpacked])) {
  console.error('生成安装包失败'); process.exit(1)
}

console.log(`\n完成。产物在 release/${version}/：Vela-${version}-setup.exe / Vela-${version}-portable.exe`)
