/**
 * 写作 Mod 体系
 *
 * 一个 Mod = 一个可切换的「改装包」：若干提示词模板覆盖 + 可选的行文指导追加段。
 * 全局存放（~/.vela/mods/），按工程启用（{project}/.vela/mods.json），
 * 可同时叠加多个：启用列表越靠后优先级越高；每次保存自动存版本历史，可回滚。
 *
 * 生效优先级（模板解析）：项目自定义 > 全局自定义 > 启用的 Mod > 内置。
 */
import { ipc } from './ipc-client'
import { randomUUID } from '../utils/id'

export interface WritingMod {
  id: string
  name: string
  description: string
  /** 保存自增版本号 */
  version: number
  updatedAt: string
  /** 模板 key → content 覆盖（仅 content，systemSuffix 始终取内置） */
  templates: Record<string, string>
  /** 追加到行文指导（注入生成/蒸馏提示词的文风段） */
  guidanceAppend: string
  /** 分类标签（尺度/节奏/文风/题材……自由填写） */
  tags?: string[]
  /** 全局禁用：各书启用列表选不到，已启用的也不生效（重新启用后恢复） */
  disabled?: boolean
}

export interface ModVersion {
  version: number
  savedAt: string
  snapshot: WritingMod
}

/** 工程启用条目：version=null 表示跟随最新，数字表示钉住该历史版本 */
export interface ModEnableEntry {
  id: string
  version: number | null
}

const HISTORY_LIMIT = 20

// ===== 内存缓存 =====
const mods: Map<string, WritingMod> = new Map()
let enabledEntries: ModEnableEntry[] = []
/** 按启用条目解析后的生效 Mod（钉住版本时为历史快照） */
let effectivePool: Map<string, WritingMod> = new Map()
let currentProjectPath: string | null = null

// ===== 纯函数（可测） =====

/** 归一化 mods.json 的 enabled 字段：兼容旧版 string[] 与新版 {id,version}[] */
export function normalizeEnabledEntries(raw: unknown): ModEnableEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ModEnableEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ id: item, version: null })
    } else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      const v = (item as { version?: unknown }).version
      out.push({ id: (item as { id: string }).id, version: typeof v === 'number' ? v : null })
    }
  }
  return out
}

/** 按启用条目挑选生效内容：钉住版本时取历史快照，找不到则回退当前版 */
export function pickModSnapshot(
  entry: ModEnableEntry,
  current: WritingMod | undefined,
  history: ModVersion[]
): WritingMod | undefined {
  if (!current) return undefined
  if (entry.version == null || entry.version === current.version) return current
  return history.find((v) => v.version === entry.version)?.snapshot ?? current
}

/** 解析模板覆盖：启用列表越靠后优先级越高 */
export function resolveModTemplate(
  key: string,
  enabled: string[],
  pool: Map<string, WritingMod>
): string | undefined {
  for (let i = enabled.length - 1; i >= 0; i--) {
    const mod = pool.get(enabled[i])
    const content = mod?.templates?.[key]
    if (content && content.trim()) return content
  }
  return undefined
}

/** 聚合启用 Mod 的行文指导追加段（按启用顺序拼接） */
export function mergeModGuidance(enabled: string[], pool: Map<string, WritingMod>): string {
  return enabled
    .map((id) => pool.get(id)?.guidanceAppend?.trim())
    .filter((s): s is string => Boolean(s))
    .join('\n\n')
}

/** 聚合全部标签及使用数（按数量降序，同数按名称） */
export function collectTags(all: WritingMod[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const mod of all) {
    for (const raw of mod.tags ?? []) {
      const tag = raw.trim()
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

/** 按标签过滤（null = 全部） */
export function filterModsByTag(all: WritingMod[], tag: string | null): WritingMod[] {
  if (!tag) return all
  return all.filter((m) => (m.tags ?? []).includes(tag))
}

// ===== 存储 =====

async function modsDir(): Promise<string> {
  const velaHome = await ipc.invoke('config:get-vela-home')
  return `${velaHome}/mods`
}

/** 加载全部 Mod（应用启动时调用一次） */
export async function loadMods(): Promise<void> {
  try {
    if (!ipc.isElectron) return
    mods.clear()
    const dir = await modsDir()
    if (!(await ipc.invoke('fs:check-exists', dir))) return
    // fs:list-dir 递归列目录，排除 history/ 子目录的版本存档
    const files = await ipc.invoke('fs:list-dir', dir)
    const isHistoryFile = (p: string) => /[\\/]history[\\/]/.test(p)
    for (const file of files.filter((f) => !f.isDir && f.name.endsWith('.json') && !isHistoryFile(f.path))) {
      const result = await ipc.invoke('fs:read-file', file.path)
      if (result.success && result.content.trim()) {
        try {
          const mod = JSON.parse(result.content) as WritingMod
          if (mod.id && mod.name) mods.set(mod.id, mod)
        } catch { /* 无效 JSON 忽略 */ }
      }
    }
    console.log(`[Vela Mods] 已加载 ${mods.size} 个 Mod`)
  } catch { /* mods 目录不存在等，忽略 */ }
}

/** 按启用条目重建生效池（钉住版本的从历史快照取） */
async function rebuildEffectivePool(): Promise<void> {
  const next = new Map<string, WritingMod>()
  for (const entry of enabledEntries) {
    const current = mods.get(entry.id)
    if (!current || current.disabled) continue
    const history =
      entry.version != null && entry.version !== current.version ? await loadModHistory(entry.id) : []
    const effective = pickModSnapshot(entry, current, history)
    if (effective) next.set(entry.id, effective)
  }
  effectivePool = next
}

/** 加载工程的启用清单（打开项目时调用） */
export async function loadProjectEnabledMods(projectPath: string): Promise<void> {
  currentProjectPath = projectPath
  enabledEntries = []
  effectivePool = new Map()
  try {
    const filePath = `${projectPath}/.vela/mods.json`
    if (await ipc.invoke('fs:check-exists', filePath)) {
      const result = await ipc.invoke('fs:read-file', filePath)
      if (result.success && result.content.trim()) {
        const parsed = JSON.parse(result.content)
        enabledEntries = normalizeEnabledEntries(parsed?.enabled)
      }
    }
  } catch { /* 忽略 */ }
  await rebuildEffectivePool()
}

/** 保存工程启用清单（含版本钉住） */
export async function saveProjectEnabledMods(enabled: ModEnableEntry[]): Promise<boolean> {
  if (!currentProjectPath) return false
  try {
    enabledEntries = enabled.map((e) => ({ id: e.id, version: e.version ?? null }))
    const res = await ipc.invoke(
      'fs:write-file',
      `${currentProjectPath}/.vela/mods.json`,
      JSON.stringify({ enabled: enabledEntries }, null, 2)
    )
    await rebuildEffectivePool()
    return res.success
  } catch {
    return false
  }
}

export function listMods(): WritingMod[] {
  return [...mods.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function getEnabledModIds(): string[] {
  return enabledEntries.map((e) => e.id)
}

export function getEnabledEntries(): ModEnableEntry[] {
  return enabledEntries.map((e) => ({ ...e }))
}

/** 当前生效的模板覆盖（供 prompt-templates 优先级链调用） */
export function getModTemplateOverride(key: string): string | undefined {
  return resolveModTemplate(key, getEnabledModIds(), effectivePool)
}

/** 当前生效的行文指导追加段 */
export function getActiveModGuidance(): string {
  return mergeModGuidance(getEnabledModIds(), effectivePool)
}

/** 新建/保存 Mod：版本自增并写入历史 */
export async function saveMod(
  mod: Omit<WritingMod, 'version' | 'updatedAt'> & { version?: number }
): Promise<WritingMod | null> {
  try {
    const dir = await modsDir()
    const prev = mods.get(mod.id)
    const next: WritingMod = {
      ...mod,
      version: (prev?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }
    // fs:write-file 失败不抛异常，必须检查返回值
    const res = await ipc.invoke('fs:write-file', `${dir}/${next.id}.json`, JSON.stringify(next, null, 2))
    if (!res.success) {
      console.error('[Vela Mods] 保存失败:', res.error)
      return null
    }
    mods.set(next.id, next)
    await appendModHistory(next)
    // 跟随最新的启用条目需要感知新版本
    await rebuildEffectivePool()
    return next
  } catch (err) {
    console.error('[Vela Mods] 保存异常:', err)
    return null
  }
}

/** 全局禁用/启用 Mod：纯开关，不占版本号、不进历史 */
export async function setModDisabled(id: string, disabled: boolean): Promise<boolean> {
  const mod = mods.get(id)
  if (!mod) return false
  const next: WritingMod = { ...mod, disabled }
  try {
    const dir = await modsDir()
    const res = await ipc.invoke('fs:write-file', `${dir}/${id}.json`, JSON.stringify(next, null, 2))
    if (!res.success) return false
    mods.set(id, next)
    await rebuildEffectivePool()
    return true
  } catch {
    return false
  }
}

/** 删除 Mod（历史保留；同时从当前工程启用清单移除） */
export async function deleteMod(id: string): Promise<boolean> {
  try {
    const dir = await modsDir()
    const filePath = `${dir}/${id}.json`
    if (await ipc.invoke('fs:check-exists', filePath)) {
      const res = await ipc.invoke('fs:write-file', filePath, '')
      if (!res.success) {
        console.error('[Vela Mods] 删除失败:', res.error)
        return false
      }
    }
    mods.delete(id)
    if (enabledEntries.some((e) => e.id === id)) {
      await saveProjectEnabledMods(enabledEntries.filter((e) => e.id !== id))
    } else {
      await rebuildEffectivePool()
    }
    return true
  } catch {
    return false
  }
}

// ===== 版本历史 =====

async function historyPath(id: string): Promise<string> {
  return `${await modsDir()}/history/${id}.json`
}

async function appendModHistory(mod: WritingMod): Promise<void> {
  try {
    const history = await loadModHistory(mod.id)
    history.unshift({ version: mod.version, savedAt: mod.updatedAt, snapshot: mod })
    await ipc.invoke(
      'fs:write-file',
      await historyPath(mod.id),
      JSON.stringify(history.slice(0, HISTORY_LIMIT), null, 2)
    )
  } catch { /* 历史失败不阻断保存 */ }
}

export async function loadModHistory(id: string): Promise<ModVersion[]> {
  try {
    const filePath = await historyPath(id)
    if (!(await ipc.invoke('fs:check-exists', filePath))) return []
    const result = await ipc.invoke('fs:read-file', filePath)
    if (!result.success || !result.content.trim()) return []
    const parsed = JSON.parse(result.content)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 回滚：把历史快照存为当前内容（版本号继续自增，回滚本身也进历史） */
export async function rollbackMod(id: string, toVersion: number): Promise<WritingMod | null> {
  const history = await loadModHistory(id)
  const target = history.find((v) => v.version === toVersion)
  if (!target) return null
  return saveMod({
    ...target.snapshot,
    id,
  })
}

// ===== 导入 / 导出 =====

/** 导出为可分享的 JSON 文本（不带本机版本历史） */
export function exportModToJson(mod: WritingMod): string {
  return JSON.stringify(
    {
      // 标记文件类型，导入侧校验用
      kind: 'vela-mod',
      name: mod.name,
      description: mod.description,
      templates: mod.templates,
      guidanceAppend: mod.guidanceAppend,
      tags: mod.tags ?? [],
    },
    null,
    2
  )
}

/** 解析导入 JSON（纯函数可测）：宽松归一，name 必须存在 */
export function parseModImport(
  json: string
): Pick<WritingMod, 'name' | 'description' | 'templates' | 'guidanceAppend' | 'tags'> | null {
  try {
    const raw = JSON.parse(json)
    if (!raw || typeof raw !== 'object') return null
    const name = String(raw.name ?? '').trim()
    if (!name) return null
    const templates: Record<string, string> = {}
    if (raw.templates && typeof raw.templates === 'object' && !Array.isArray(raw.templates)) {
      for (const [k, v] of Object.entries(raw.templates)) {
        if (typeof v === 'string' && v.trim()) templates[k] = v
      }
    }
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((t: unknown): t is string => typeof t === 'string' && t.trim() !== '')
      : []
    return {
      name,
      description: String(raw.description ?? ''),
      templates,
      guidanceAppend: typeof raw.guidanceAppend === 'string' ? raw.guidanceAppend : '',
      tags,
    }
  } catch {
    return null
  }
}

/** 导入 Mod：始终新建（新 id、v1），避免覆盖本机同名 Mod */
export async function importModFromJson(json: string): Promise<WritingMod | null> {
  const parsed = parseModImport(json)
  if (!parsed) return null
  const nameTaken = listMods().some((m) => m.name === parsed.name)
  return saveMod({
    id: randomUUID(),
    ...parsed,
    name: nameTaken ? `${parsed.name}（导入）` : parsed.name,
  })
}

// ===== 标签全局管理 =====

/** 全局改名标签（作用于所有含该标签的 Mod，各自版本 +1） */
export async function renameTagEverywhere(oldTag: string, newTag: string): Promise<number> {
  const next = newTag.trim()
  if (!next || next === oldTag) return 0
  let changed = 0
  for (const mod of listMods()) {
    const tags = mod.tags ?? []
    if (!tags.includes(oldTag)) continue
    const updated = [...new Set(tags.map((t) => (t === oldTag ? next : t)))]
    if (await saveMod({ ...mod, tags: updated })) changed++
  }
  return changed
}

/** 全局删除标签（作用于所有含该标签的 Mod，各自版本 +1） */
export async function removeTagEverywhere(tag: string): Promise<number> {
  let changed = 0
  for (const mod of listMods()) {
    const tags = mod.tags ?? []
    if (!tags.includes(tag)) continue
    if (await saveMod({ ...mod, tags: tags.filter((t) => t !== tag) })) changed++
  }
  return changed
}
