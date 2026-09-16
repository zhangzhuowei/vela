/**
 * 新书导入包的落盘：解析保存目录（全局设置 / 弹框）与写出 book.json / characters.json。
 * 命令与「生成记录 → 重新保存」共用，避免各写一份路径拼接。
 */
import { ipc } from './ipc-client'
import { bookSeedFileNames, joinExportPath } from './reference/book-seed-io'

/**
 * 取导入包保存目录：设置里有就用；没有则弹目录框，`remember` 为真时回写设置。
 * 用户取消返回 null。
 */
export async function resolveBookSeedDir(opts: { remember: boolean }): Promise<string | null> {
  const cfg = await ipc.invoke('config:get')
  const saved = cfg.bookSeedExportDir?.trim()
  if (saved) return saved
  const dir = await ipc.invoke('dialog:select-folder')
  if (!dir) return null
  if (opts.remember) await ipc.invoke('config:set', { bookSeedExportDir: dir })
  return dir
}

/** 写出两份 JSON（空的跳过），返回实际写出的绝对路径；任一步失败抛错 */
export async function writeBookSeedFiles(params: {
  dir: string
  workName: string
  generatedAt: string
  bookJson: string
  charactersJson: string
}): Promise<string[]> {
  const mk = await ipc.invoke('fs:mkdir', params.dir)
  if (!mk.success) throw new Error(mk.error || params.dir)
  const names = bookSeedFileNames(params.workName, params.generatedAt)
  const written: string[] = []
  for (const [name, content] of [[names.book, params.bookJson], [names.characters, params.charactersJson]] as const) {
    if (!content) continue
    const path = joinExportPath(params.dir, name)
    const res = await ipc.invoke('fs:write-file', path, content)
    if (!res.success) throw new Error(res.error || path)
    written.push(path)
  }
  return written
}
