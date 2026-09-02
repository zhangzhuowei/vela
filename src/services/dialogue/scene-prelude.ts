/**
 * 对话创作 · 场间前情
 *
 * 按书级开关决定后一场生成时带哪些已收场上下文。
 * 与「多线联动 / 同线摘要」独立：按场序衔接，不看线名。
 */

export type ScenePreludeMode = 'off' | 'prev_ending' | 'chapter_summaries'

/** 上一场结尾截取长度，与管线写稿「上一章结尾」一致 */
export const PREV_ENDING_CHARS = 1000

/** 无摘要缓存时，用正文开头顶一段，避免空注入 */
const BODY_CLIP_CHARS = 150

export type PreludeScene = {
  seq: number
  title: string
  status: 'open' | 'distilled'
  body: string
  summary: string
}

export function resolveScenePreludeMode(raw?: string | null): ScenePreludeMode {
  if (raw === 'off' || raw === 'prev_ending' || raw === 'chapter_summaries') return raw
  return 'chapter_summaries'
}

function priorDistilled(scenes: PreludeScene[], currentSeq: number): PreludeScene[] {
  return scenes
    .filter((s) => s.seq < currentSeq && s.status === 'distilled')
    .sort((a, b) => a.seq - b.seq)
}

function clipBody(body: string): string {
  const text = body.trim()
  if (!text) return ''
  return text.length <= BODY_CLIP_CHARS ? text : text.slice(0, BODY_CLIP_CHARS)
}

export function buildScenePrelude(params: {
  mode: ScenePreludeMode
  currentSeq: number
  scenes: PreludeScene[]
}): string {
  if (params.mode === 'off') return ''
  const prior = priorDistilled(params.scenes, params.currentSeq)
  if (prior.length === 0) return ''

  if (params.mode === 'prev_ending') {
    const prev = prior[prior.length - 1]
    const ending = prev.body.trim().slice(-PREV_ENDING_CHARS)
    if (!ending) return ''
    return `上一场（${prev.title}）结尾：\n${ending}`
  }

  const lines = prior
    .map((s) => {
      const text = s.summary.trim() || clipBody(s.body)
      return text ? `【${s.title}】${text}` : ''
    })
    .filter(Boolean)
  if (lines.length === 0) return ''
  return `本章已收场：\n${lines.join('\n')}`
}
