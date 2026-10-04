/**
 * MCP stdio 子进程的启动参数：环境变量白名单、配置指纹、Windows 命令解析。
 *
 * - 环境变量：子进程不再继承 Vela 的完整环境（其中可能有用户设置的各种 Token、ELECTRON_RUN_AS_NODE 等），
 *   只继承运行命令所需的基础变量与代理设置，再叠加配置文件里为该服务器写明的 env。
 * - 指纹：command / args / env / url 的 sha256，用于「首次运行确认」——配置任何一项变化都需要重新确认。
 * - Windows：npx、pnpm 等是 .cmd 脚本。Node 18.20.2+ 起不带 shell 直接 spawn .cmd 会报 EINVAL，
 *   不写扩展名则直接 ENOENT；这里改为经 cmd.exe 启动并按 cmd 规则逐个转义参数（同 cross-spawn 的做法），
 *   不使用 shell: true，避免参数里的 & | > 等被 cmd 解释。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SpawnOptions } from 'node:child_process'

const isWindows = process.platform === 'win32'

/** 子进程可继承的基础环境变量（参考 MCP 官方 SDK 的默认继承列表，补充了 Windows 下解析命令所需的几项） */
const INHERITED_ENV_VARS = isWindows
  ? [
    'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'COMSPEC', 'WINDIR',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS',
  ]
  : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']

/** 代理设置（应用内配置的代理会写进这几个变量）。Windows 环境变量不区分大小写，只取大写名，避免重复键 */
const PROXY_ENV_VARS = isWindows
  ? ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
  : ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']

/**
 * 组装子进程环境：白名单内的基础变量 + 配置里写明的 env（后者优先）。
 * 以 "()" 开头的值是 bash 导出的函数定义，不继承（与 MCP 官方 SDK 一致）。
 */
export function buildMcpEnv(
  extra: Record<string, unknown> | undefined,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...INHERITED_ENV_VARS, ...PROXY_ENV_VARS]) {
    const value = source[key]
    if (typeof value === 'string' && !value.startsWith('()')) env[key] = value
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/** 参与指纹计算的启动配置 */
export interface MCPLaunchSpec {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}

/** 启动配置指纹：任何一项（含 env 的值）变化都会得到不同指纹 */
export function computeMcpFingerprint(spec: MCPLaunchSpec): string {
  const env = spec.env ?? {}
  const canonical = JSON.stringify({
    command: spec.command ?? '',
    args: spec.args ?? [],
    env: Object.keys(env).sort().map((k) => [k, env[k]]),
    url: spec.url ?? '',
  })
  return createHash('sha256').update(canonical).digest('hex')
}

// ===== Windows：经 cmd.exe 启动 .cmd / .bat =====

/** cmd.exe 的元字符（参考 cross-spawn），需要用 ^ 转义 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g

/** 位于 node_modules/.bin 的 cmd-shim 会再经一次 cmd 解析，元字符需要双重转义 */
const CMD_SHIM_PATH = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i

/** 按 MSVCRT 的命令行规则给单个参数加引号（https://qntm.org/cmd 的算法；线性扫描，没有正则回溯） */
function quoteArgument(arg: string): string {
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    // 引号前的反斜杠加倍，再转义引号本身；其他位置的反斜杠照原样保留
    out += ch === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${ch}`
    backslashes = 0
  }
  // 结尾的反斜杠后面紧跟收尾引号，也要加倍
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

export function escapeCmdArgument(arg: string, doubleEscapeMetaChars = false): string {
  let escaped = quoteArgument(String(arg)).replace(CMD_META_CHARS, '^$1')
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META_CHARS, '^$1')
  return escaped
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 按 PATH + PATHEXT 找到命令对应的实际文件（Windows）；找不到返回 null */
export function resolveWindowsCommand(command: string, env: Record<string, string>): string | null {
  const pathExt = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toUpperCase()).filter(Boolean)
  const ext = path.extname(command).toUpperCase()
  // 已带可执行扩展名：只找原名；否则依次尝试原名（仅当名字里有点号）与各扩展名
  const names = ext && pathExt.includes(ext)
    ? [command]
    : [...(command.includes('.') ? [command] : []), ...pathExt.map((e) => command + e)]

  const hasDir = command.includes('\\') || command.includes('/')
  const dirs = hasDir ? [''] : (env.PATH || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? path.join(dir, name) : path.resolve(name)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

export interface ResolvedSpawn {
  command: string
  args: string[]
  options: SpawnOptions
}

/**
 * 计算实际的 spawn 参数。
 * Windows 上，除 .exe / .com 外的命令（.cmd / .bat 等）经 cmd.exe /d /s /c 启动，参数逐个按 cmd 规则转义。
 */
export function resolveSpawn(command: string, args: string[], env: Record<string, string>): ResolvedSpawn {
  // NodeJS.ProcessEnv 被 electron-env.d.ts 扩展了 APP_ROOT 等必填字段，子进程环境不需要它们
  const spawnEnv = Object.assign({} as NodeJS.ProcessEnv, env)
  const baseOptions: SpawnOptions = { env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  if (!isWindows) return { command, args, options: baseOptions }

  const resolved = resolveWindowsCommand(command, env)
  // 找不到时原样 spawn，让系统给出 ENOENT；.exe / .com 可直接启动
  if (!resolved || /\.(?:com|exe)$/i.test(resolved)) return { command: resolved ?? command, args, options: baseOptions }

  // .cmd 脚本通常用 %* 把参数原样转给下一条命令，cmd 会再解析一遍：参数里的双引号会打乱 cmd 的引号配对，
  // 让其后的 & | 等重新生效；换行会直接截断命令。这两类字符无法可靠转义，直接拒绝
  const unsafe = args.find((a) => /["\r\n]/.test(a))
  if (unsafe !== undefined) {
    throw new Error(`Windows 下经 .cmd/.bat 启动的 MCP 服务器，参数不能包含双引号或换行：${unsafe}`)
  }
  // 脚本路径放在一对未转义的引号里（可含空格，& 等在引号内不生效）；% 在引号里仍会被展开，不接受
  if (resolved.includes('%')) {
    throw new Error(`Windows 下经 .cmd/.bat 启动的 MCP 服务器，脚本路径不能包含 %：${resolved}`)
  }

  const doubleEscape = CMD_SHIM_PATH.test(resolved)
  // 用解析出的完整路径而不是原命令名，避免 cmd 先在当前目录里找同名脚本
  const commandLine = [
    `"${resolved}"`,
    ...args.map((a) => escapeCmdArgument(a, doubleEscape)),
  ].join(' ')
  return {
    command: env.COMSPEC || process.env.COMSPEC || 'cmd.exe',
    // /d 不执行注册表 AutoRun；/v:off 关闭延迟展开，参数里的 ! 按字面传递
    args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
    // 参数已按 cmd 规则转义，不能再让 Node 按 MSVCRT 规则加一层引号
    options: { ...baseOptions, windowsVerbatimArguments: true },
  }
}
