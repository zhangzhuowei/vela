/**
 * 设定纲要 — 落库与知识库同步（渲染进程，走 IPC）
 */
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
import { globalEventBus } from '../shared/event-bus'
import type { SettingModuleInput } from '../../electron/repositories/setting-module-repository'
import {
  buildSettingDigest,
  defaultModulesForGenre,
  isGridEmpty,
  kbDocumentText,
  kbFileName,
  KB_FILE_PREFIX,
  serializeGrid,
  emptyGrid,
  type SettingModuleData,
  type SettingModulePortable,
} from './setting-bible'

export async function listSettingModules(): Promise<SettingModuleData[]> {
  try {
    return await ipc.invoke('db:setting-module-list')
  } catch {
    return []
  }
}

/**
 * 写稿 / 对话注入用：常驻模块摘要 + 本章 / 本场点名模块全文。
 * 点名来自章节蓝图的 settingKeys 与场的 settingKeys（并集）。任何失败都返回空串，不阻塞创作。
 */
export async function loadSettingDigest(scope: { chapterNumber?: number; sceneId?: number } = {}): Promise<string> {
  const modules = await listSettingModules()
  if (modules.length === 0) return ''
  const focus = new Set<string>()
  if (scope.chapterNumber) {
    try {
      const bp = await ipc.invoke('db:blueprint-get', scope.chapterNumber)
      for (const k of bp?.settingKeys ?? []) focus.add(k)
    } catch { /* 无蓝图时只用常驻 */ }
  }
  if (scope.sceneId) {
    try {
      const scenes = scope.chapterNumber ? await ipc.invoke('db:scene-list', scope.chapterNumber) : []
      const scene = scenes.find((s) => s.id === scope.sceneId)
      for (const k of scene?.settingKeys ?? []) focus.add(k)
    } catch { /* 忽略 */ }
  }
  return buildSettingDigest(modules, [...focus])
}

/** 保存模块并把正文同步进知识库（关闭或空正文则只清理旧文档） */
export async function saveSettingModule(input: SettingModuleInput): Promise<SettingModuleData | null> {
  const res = await ipc.invoke('db:setting-module-upsert', input)
  if (!res.success || !res.id) throw new Error(res.error || '保存失败')
  const saved: SettingModuleData = { ...input, id: res.id, updatedAt: new Date().toISOString() }
  const kbDocId = await syncModuleToKB(saved)
  if (kbDocId !== saved.kbDocId) {
    saved.kbDocId = kbDocId
    await ipc.invoke('db:setting-module-upsert', { ...saved })
  }
  globalEventBus.emit('SETTING_MODULES_CHANGED', {})
  return saved
}

export async function deleteSettingModule(m: SettingModuleData): Promise<void> {
  await removeModuleFromKB(m)
  await ipc.invoke('db:setting-module-delete', m.id)
  globalEventBus.emit('SETTING_MODULES_CHANGED', {})
}

export async function reorderSettingModules(ids: number[]): Promise<void> {
  await ipc.invoke('db:setting-module-reorder', ids)
  globalEventBus.emit('SETTING_MODULES_CHANGED', {})
}

/** 首次打开：按类型铺一套空模块（已有模块时不动） */
export async function seedDefaultModules(genre: string): Promise<SettingModuleData[]> {
  const existing = await listSettingModules()
  if (existing.length > 0) return existing
  const specs = defaultModulesForGenre(genre)
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    await ipc.invoke('db:setting-module-upsert', {
      key: s.key,
      title: s.title,
      sortOrder: i,
      injectMode: s.injectMode ?? 'retrieval',
      body: serializeGrid(emptyGrid()),
      summary: '',
      source: 'user',
      kbDocId: '',
    })
  }
  globalEventBus.emit('SETTING_MODULES_CHANGED', {})
  return listSettingModules()
}

/**
 * 导入 JSON 里的模块：同 key 的覆盖正文与注入方式，新 key 追加到末尾。
 * 返回写入条数。
 */
export async function importSettingModules(items: SettingModulePortable[]): Promise<number> {
  const existing = await listSettingModules()
  let order = existing.length
  let count = 0
  for (const item of items) {
    const hit = existing.find((m) => m.key === item.key)
    await saveSettingModule(
      hit
        ? { ...hit, title: item.title, injectMode: item.injectMode, body: item.body, summary: item.summary, source: 'user' }
        : { key: item.key, title: item.title, sortOrder: order++, injectMode: item.injectMode, body: item.body, summary: item.summary, source: 'user', kbDocId: '' },
    )
    count++
  }
  return count
}

// ---------------------------------------------------------------------------
// 知识库同步
// ---------------------------------------------------------------------------

async function removeModuleFromKB(m: Pick<SettingModuleData, 'title' | 'kbDocId'>): Promise<void> {
  try {
    const docs = await ipc.invoke('kb:list-documents')
    const target = kbFileName(m.title)
    for (const d of docs) {
      if ((m.kbDocId && d.id === m.kbDocId) || d.fileName === target) {
        await ipc.invoke('kb:remove-document', d.id)
      }
    }
  } catch {
    /* 知识库不可用不阻塞保存 */
  }
}

/**
 * 同步一个模块到知识库：先删旧文档再导新的。
 * 返回新文档 id（关闭 / 空正文 / 失败 → ''）。
 */
async function syncModuleToKB(m: SettingModuleData): Promise<string> {
  const project = useProjectStore.getState().currentProject
  await removeModuleFromKB(m)
  if (!project || m.injectMode === 'off' || isGridEmpty(m.body)) return ''
  try {
    const res = await ipc.invoke('kb:import-text', kbDocumentText(m), kbFileName(m.title), project.path)
    return res.success && res.docId ? res.docId : ''
  } catch {
    return ''
  }
}

/** 侧栏知识库列表用：这个文档是不是纲要同步出来的 */
export function isSettingKBDocument(fileName: string): boolean {
  return fileName.startsWith(KB_FILE_PREFIX)
}
