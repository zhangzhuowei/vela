/**
 * 编辑器正文持久化 —— 按 Tab 的路径协议决定写到哪里
 *
 * - vela://draft/<id>、vela://manuscript/<id>：草稿 / 终稿正文，写 SQLite（db:draft-update-content）
 * - vela://core/<field>：架构文档，写 project_core 对应字段
 * - 其他：物理文件，走 fs:write-file（主进程临时文件 + rename 原子写）
 *
 * 手动保存、自动保存、关窗刷盘共用这一份逻辑。此前各编辑器各写一套：
 * 终稿 Tab 把 vela://manuscript/ 当成物理路径交给 fs:write-file，写入失败却照样清掉未保存标记。
 */
import i18n from '../i18n'
import { ipc } from './ipc-client'
import { writeCoreContent } from './vela-protocol'

export interface PersistResult {
  success: boolean
  error?: string
}

/** 解析草稿类伪路径（vela://draft/<id> / vela://manuscript/<id>）中的草稿 ID；不是草稿路径返回 null */
export function parseDraftIdFromPath(filePath: string): number | null {
  const m = /^vela:\/\/(?:draft|manuscript)\/(\d+)/.exec(filePath)
  return m ? Number(m[1]) : null
}

/** 把编辑器正文写回它的来源（DB 字段或物理文件）。不抛异常，失败信息在返回值里 */
export async function persistEditorContent(filePath: string, text: string): Promise<PersistResult> {
  try {
    const draftId = parseDraftIdFromPath(filePath)
    if (draftId !== null) {
      const res = await ipc.invoke('db:draft-update-content', draftId, text, text.length)
      return res?.success === false
        ? { success: false, error: res.error || i18n.t('failed', { ns: 'common' }) }
        : { success: true }
    }

    if (filePath.startsWith('vela://core/')) {
      const ok = await writeCoreContent(filePath, text)
      return ok ? { success: true } : { success: false, error: i18n.t('failed', { ns: 'common' }) }
    }

    // 其余 vela:// 伪路径（如版本对比 Tab 的 vela://draft/ch5）没有可写的实体，不能当物理路径写盘
    if (filePath.startsWith('vela://')) {
      return { success: false, error: i18n.t('unsupportedSavePath', { ns: 'common', path: filePath }) }
    }

    const res = await ipc.invoke('fs:write-file', filePath, text)
    return res?.success === false
      ? { success: false, error: res.error || i18n.t('failed', { ns: 'common' }) }
      : { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
