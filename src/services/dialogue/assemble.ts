/**
 * 对话创作模式 — 汇稿：把本章所有已收场的场正文按场序拼成章草稿
 */
import type { SceneData } from '../../../electron/repositories/scene-repository'

export function assembleChapterBody(scenes: SceneData[]): string {
  if (scenes.length === 0) throw new Error('本章还没有场')
  const open = scenes.filter((s) => s.status !== 'distilled')
  if (open.length > 0) {
    throw new Error(`还有 ${open.length} 个场未收场：${open.map((s) => s.title || `场${s.seq}`).join('、')}`)
  }
  const bodies = [...scenes]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => s.body.trim())
    .filter(Boolean)
  if (bodies.length === 0) throw new Error('没有可汇稿的场正文')
  return bodies.join('\n\n')
}
