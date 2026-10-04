/**
 * 主进程文件访问约束：渲染进程经 IPC 传来的路径一律在这里校验后才落到磁盘操作。
 *
 * 放行范围：
 * - 当前打开的项目目录：读写
 * - ~/.vela/prompts：读写；~/.vela/skills：只读
 * - 本次运行中用户经系统对话框选中的位置：选文件夹 → 读写；选文件 → 只读
 *
 * 无论是否落在上述范围内，一律拒绝：
 * - ~/.vela 根目录本身、根目录下的文件（config.json、models.json、recent-projects.json、mcp_config.json
 *   以及它们的 .bak / .corrupt 副本等）、~/.vela/logs
 * - 任意位置的 .vela/vela.db*、.vela/lancedb、.vela/backups（项目数据只能经由主进程的库接口读写）
 *
 * 判定方式：要求绝对路径 → path.resolve 规整 → 对最近的已存在祖先做 realpath
 * （符号链接、目录联接、Windows 短文件名都不能把访问带出范围）→ 用 path.relative 判断包含关系（Windows 下不区分大小写）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { VELA_HOME, RECENT_PROJECTS_PATH, readJsonFile } from './utils/config-utils'
import { getCurrentProjectPath } from './database'

export type PathAccess = 'read' | 'write'

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathAccessError'
  }
}

/**
 * 校验结果。path 为 path.resolve 后的路径（不是 realpath），调用方用它做实际的磁盘操作，
 * 这样返回给渲染进程的路径（例如目录列表）仍与它传入的写法一致。
 * kind：forbidden = 受保护位置（任何授权都不放行）；outside = 不在放行范围内；invalid = 路径本身不合法
 */
export type PathCheckResult =
  | { ok: true; path: string }
  | { ok: false; kind: 'forbidden' | 'outside' | 'invalid'; error: string }

export interface PathGrant {
  /** canonicalizePath 之后的路径 */
  path: string
  access: PathAccess
}

export interface PathPolicyContext {
  velaHome: string
  projectPath: string | null
  grants: readonly PathGrant[]
}

const isWindows = process.platform === 'win32'

/** Windows 路径不区分大小写：比较前统一转小写 */
function foldCase(p: string): string {
  return isWindows ? p.toLowerCase() : p
}

/** 规整为可比较的真实绝对路径：对最近的已存在祖先做 realpath，再拼回尚不存在的尾部 */
export function canonicalizePath(target: string): string {
  const resolved = path.resolve(target)
  const tail: string[] = []
  let current = resolved
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail)
    } catch {
      const parent = path.dirname(current)
      // 一路到根都无法 realpath（盘符不存在等）：退回 resolve 结果
      if (parent === current) return resolved
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

/** child 是否等于 parent 或位于其内部（两者都应已 canonicalize） */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(foldCase(parent), foldCase(child))
  if (rel === '') return true
  // Windows 下不同盘符时 relative 返回绝对路径
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

export function isSamePath(a: string, b: string): boolean {
  return path.relative(foldCase(a), foldCase(b)) === ''
}

function deny(kind: 'forbidden' | 'outside' | 'invalid', error: string): PathCheckResult {
  return { ok: false, kind, error }
}

/**
 * ~/.vela 内的判定：prompts 读写、skills 只读；根目录本身、根目录下的文件与 logs 一律拒绝。
 * 返回 null 表示不在 ~/.vela 内，或是 ~/.vela 下的其他子目录（例如用户把项目放在这里），交给后续规则。
 */
function velaHomeVerdict(canonical: string, access: PathAccess, velaHome: string): 'allow' | PathCheckResult | null {
  if (!isPathInside(canonical, velaHome)) return null
  if (isPathInside(canonical, path.join(velaHome, 'prompts'))) return 'allow'
  if (isPathInside(canonical, path.join(velaHome, 'skills'))) {
    return access === 'read' ? 'allow' : deny('forbidden', '~/.vela/skills 为只读目录')
  }

  const rel = path.relative(foldCase(velaHome), foldCase(canonical))
  const segments = rel === '' ? [] : rel.split(path.sep)
  const protectedMessage = '~/.vela 下的配置文件（模型与 API Key、全局配置、最近项目等）只能由应用自身读写'
  if (segments.length === 0 || segments[0] === 'logs') return deny('forbidden', protectedMessage)
  if (segments.length === 1) {
    // 根目录下的条目：只有已存在的子目录按普通规则判断，其余（配置文件及其副本、将来新增的文件）一律拒绝
    let isDir = false
    try { isDir = fs.statSync(canonical).isDirectory() } catch { /* 不存在 */ }
    if (!isDir) return deny('forbidden', protectedMessage)
  }
  return null
}

/**
 * Windows 下保守地去掉文件名结尾的点和空格再比较（Win32 层会忽略它们）。
 * "名称:流" 写法在 validateInput 已拒绝，这里的去冒号只是兜底。
 */
function normalizeSegment(segment: string): string {
  return isWindows ? segment.replace(/:.*$/, '').replace(/[. ]+$/, '') : segment
}

/** 是否为项目内部数据：.vela/vela.db*、.vela/lancedb/**、.vela/backups/** */
function isProjectInternalData(canonical: string): boolean {
  const segments = foldCase(canonical).split(path.sep).map(normalizeSegment)
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] !== '.vela') continue
    const next = segments[i + 1]
    if (next === 'lancedb' || next === 'backups' || next.startsWith('vela.db')) return true
  }
  return false
}

/** 路径本身的合法性（类型、空值、NUL、相对路径、Windows 数据流写法） */
function validateInput(target: unknown): PathCheckResult {
  if (typeof target !== 'string' || target.trim() === '') return deny('invalid', '路径为空')
  if (target.includes('\0')) return deny('invalid', '路径包含非法字符')
  if (!path.isAbsolute(target)) return deny('invalid', `需要绝对路径：${target}`)
  const resolved = path.resolve(target)
  // Windows 文件名不允许冒号：盘符之后再出现的冒号只可能是 "文件:流" 写法（可借此以别名访问同一文件），一律拒绝
  if (isWindows && resolved.slice(path.parse(resolved).root.length).includes(':')) {
    return deny('invalid', `路径包含非法字符：${target}`)
  }
  return { ok: true, path: resolved }
}

/** 受保护位置判定：返回 'allow'（~/.vela 下的放行目录）/ 拒绝结果 / null（交给后续规则） */
function protectedVerdict(canonical: string, access: PathAccess, velaHome: string, original: string): 'allow' | PathCheckResult | null {
  const home = velaHomeVerdict(canonical, access, canonicalizePath(velaHome))
  if (home) return home
  if (isProjectInternalData(canonical)) {
    return deny('forbidden', `项目数据库、向量库与备份只能由应用自身读写：${original}`)
  }
  return null
}

function coveredByGrant(canonical: string, access: PathAccess, grantList: readonly PathGrant[]): boolean {
  return grantList.some((grant) =>
    (access === 'read' || grant.access === 'write') && isPathInside(canonical, grant.path))
}

/** 纯判定函数（不读取全局状态，便于测试） */
export function evaluatePathAccess(target: unknown, access: PathAccess, ctx: PathPolicyContext): PathCheckResult {
  const input = validateInput(target)
  if (!input.ok) return input
  const original = target as string
  const canonical = canonicalizePath(input.path)

  const verdict = protectedVerdict(canonical, access, ctx.velaHome, original)
  if (verdict === 'allow') return input
  if (verdict) return verdict

  if (ctx.projectPath && isPathInside(canonical, canonicalizePath(ctx.projectPath))) return input
  if (coveredByGrant(canonical, access, ctx.grants)) return input

  return deny(
    'outside',
    `无权${access === 'write' ? '写入' : '读取'}该路径：${original}（仅允许当前项目、~/.vela/prompts 以及通过对话框选择的位置）`,
  )
}

// ===== 会话内授权（用户经系统对话框选中的位置） =====

const grants = new Map<string, PathGrant>()

/** 记录用户经对话框选中的位置；同一位置已有写权限时不降级 */
export function grantPathAccess(target: string, access: PathAccess): void {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return
  const canonical = canonicalizePath(target)
  const key = foldCase(canonical)
  if (grants.get(key)?.access === 'write') return
  grants.set(key, { path: canonical, access })
}

/** 仅供测试：清空会话授权 */
export function resetPathGrantsForTest(): void {
  grants.clear()
}

function currentContext(): PathPolicyContext {
  return { velaHome: VELA_HOME, projectPath: getCurrentProjectPath(), grants: [...grants.values()] }
}

function logDenied(result: PathCheckResult, access: PathAccess, target: unknown): void {
  if (!result.ok) console.warn(`[Vela PathGuard] 拒绝${access === 'write' ? '写入' : '读取'}（${result.kind}）：${String(target)}`)
}

export function checkPathAccess(target: unknown, access: PathAccess): PathCheckResult {
  const result = evaluatePathAccess(target, access, currentContext())
  logDenied(result, access, target)
  return result
}

/** 校验通过返回可用于磁盘操作的路径，否则抛 PathAccessError */
export function assertPathAccess(target: unknown, access: PathAccess): string {
  const result = checkPathAccess(target, access)
  if (!result.ok) throw new PathAccessError(result.error)
  return result.path
}

// ===== 项目目录 =====

/** 是否为当前项目或最近项目列表中的项目（最近列表只由主进程在创建/打开/保存当前项目时写入） */
export function isKnownProjectPath(target: string): boolean {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false
  const canonical = canonicalizePath(target)
  const current = getCurrentProjectPath()
  if (current && isSamePath(canonical, canonicalizePath(current))) return true
  const recent = readJsonFile<Array<{ path?: unknown }>>(RECENT_PROJECTS_PATH, [])
  return Array.isArray(recent) && recent.some((p) =>
    typeof p?.path === 'string' && path.isAbsolute(p.path) && isSamePath(canonical, canonicalizePath(p.path)))
}

/**
 * 打开项目（纯判定）：打开后整个目录对渲染进程可读写，所以只接受已知项目（当前 / 最近）
 * 或本次运行中经对话框选中的位置；受保护位置不能作为项目目录
 */
export function evaluateProjectOpenAccess(
  projectPath: unknown,
  ctx: PathPolicyContext,
  isKnownProject: (p: string) => boolean,
): PathCheckResult {
  const input = validateInput(projectPath)
  if (!input.ok) return input
  const canonical = canonicalizePath(input.path)
  const verdict = protectedVerdict(canonical, 'write', ctx.velaHome, projectPath as string)
  if (verdict === 'allow') return deny('forbidden', '不能把 ~/.vela 下的应用目录作为项目打开')
  if (verdict) return verdict
  if (isKnownProject(input.path) || coveredByGrant(canonical, 'write', ctx.grants)) return input
  return deny('outside', '请通过「打开项目」对话框选择项目文件夹')
}

export function checkProjectOpenAccess(projectPath: unknown): PathCheckResult {
  const result = evaluateProjectOpenAccess(projectPath, currentContext(), isKnownProjectPath)
  logDenied(result, 'write', projectPath)
  return result
}

/** 可视为空目录的系统杂项文件 */
const IGNORABLE_DIR_ENTRIES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function isMissingOrEmptyDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false
    return fs.readdirSync(dir).every((name) => IGNORABLE_DIR_ENTRIES.has(name.toLowerCase()))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * 新建项目（纯判定）：目标目录不能在受保护位置；位于经对话框选中的位置（或当前项目）内时直接放行，
 * 手动输入的位置则要求目标目录尚不存在或为空——新项目只能拿到一个全新的目录，不会因此获得既有目录的读写权。
 */
export function evaluateProjectCreateAccess(projectDir: unknown, ctx: PathPolicyContext): PathCheckResult {
  const result = evaluatePathAccess(projectDir, 'write', ctx)
  if (result.ok) {
    if (velaHomeVerdict(canonicalizePath(result.path), 'write', canonicalizePath(ctx.velaHome)) === 'allow') {
      return deny('forbidden', '不能在 ~/.vela 下的应用目录里新建项目')
    }
    return result
  }
  if (result.kind !== 'outside') return result
  const resolved = path.resolve(projectDir as string)
  if (isMissingOrEmptyDir(resolved)) return { ok: true, path: resolved }
  return deny('outside', '该位置已有同名且非空的文件夹。请换一个项目名称，或点击「选择文件夹」指定保存位置')
}

export function checkProjectCreateAccess(projectDir: string): PathCheckResult {
  const result = evaluateProjectCreateAccess(projectDir, currentContext())
  logDenied(result, 'write', projectDir)
  return result
}

// ===== 项目名 → 文件夹名 =====

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 把项目名转成单段文件夹名：路径分隔符、Windows 非法字符与控制字符替换为 _，去掉首尾空白与结尾的点，
 * 避开 Windows 保留设备名。结果为空（例如只有点号）时返回空字符串，调用方应视为名称无效。
 */
export function toSafeFolderName(name: unknown): string {
  if (typeof name !== 'string') return ''
  let folder = Array.from(name.trim(), (ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch))
    .slice(0, 120)
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
  if (folder === '') return ''
  if (WINDOWS_RESERVED_NAME.test(folder)) folder = `_${folder}`
  return folder
}
