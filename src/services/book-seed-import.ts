/**
 * 把 book seed 写进当前项目：小说配置 + 故事架构四件。
 * 角色卡不在这里——用角色卡侧栏的导入。
 */
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
import { parseBookSeedImport, diffOverwrites, applyBookSeed, type BookSeedFile, type BookSeedTarget } from './reference/book-seed-io'

export type BookSeedImportResult =
  | { ok: true; written: number }
  | { ok: false; reason: 'noProject' | 'saveFailed'; error?: string }

async function readTarget(): Promise<BookSeedTarget | null> {
  const project = useProjectStore.getState().currentProject
  if (!project) return null
  const core = await ipc.invoke('db:project-core-get')
  return {
    novelConfig: project.novelConfig,
    core: { premise: core?.premise, charactersArch: core?.charactersArch, worldbuilding: core?.worldbuilding, synopsis: core?.synopsis },
  }
}

/** 解析 + 计算覆盖清单；不写盘 */
export async function prepareBookSeedImport(json: string): Promise<{ seed: BookSeedFile; overwrites: string[] } | null> {
  const seed = parseBookSeedImport(json)
  if (!seed) return null
  const target = await readTarget()
  if (!target) return null
  return { seed, overwrites: diffOverwrites(target, seed) }
}

/** 真正写入；调用方已经拿到用户确认 */
export async function commitBookSeedImport(seed: BookSeedFile): Promise<BookSeedImportResult> {
  const target = await readTarget()
  if (!target) return { ok: false, reason: 'noProject' }
  const { novelConfig, core: coreArch } = applyBookSeed(target, seed)
  let written = 0
  if (Object.keys(novelConfig).length > 0) {
    useProjectStore.getState().updateNovelConfig(novelConfig)
    const saved = await useProjectStore.getState().saveProject()
    if (!saved) return { ok: false, reason: 'saveFailed' }
    written += Object.keys(novelConfig).length
  }
  if (Object.keys(coreArch).length > 0) {
    const r = await ipc.invoke('db:project-core-update', coreArch)
    if (!r.success) return { ok: false, reason: 'saveFailed', error: r.error }
    written += Object.keys(coreArch).length
  }
  return { ok: true, written }
}
