/**
 * 编辑器定位请求 — 全局搜索点击结果后，在对应章节编辑器里定位并高亮命中
 *
 * 请求先按 filePath 登记，再由编辑器取走：
 *   - 目标编辑器已挂载（就是当前 Tab）：订阅回调里立即处理；
 *   - 尚未挂载（新开 Tab / 切换 Tab）：编辑器创建时取走。
 * 请求有有效期：打开失败时残留的请求，不会在很久以后打开同一章时突然生效。
 */
import { buildLiteralMatcher } from '../shared/text-search'

export interface EditorRevealRequest {
  filePath: string
  /** 期望的命中位置（主进程按数据库里的正文算出，换行已统一为 \n） */
  from: number
  to: number
  /** 命中文本：编辑器内容与数据库不一致（例如有未保存的修改）时，据此就近重新定位 */
  text: string
  /** 搜索时是否区分大小写（就近重新定位时沿用） */
  caseSensitive?: boolean
}

/** 请求有效期 */
export const REVEAL_TTL_MS = 5000

const pending = new Map<string, EditorRevealRequest & { at: number }>()
const listeners = new Set<(filePath: string) => void>()

/** 登记定位请求并通知已挂载的编辑器；同一文件只保留最新一次请求 */
export function requestEditorReveal(req: EditorRevealRequest, now = Date.now()): void {
  pending.set(req.filePath, { ...req, at: now })
  for (const listener of [...listeners]) listener(req.filePath)
}

/** 取走某文件的定位请求（取走即删除；过期的请求丢弃并返回 null） */
export function takeEditorReveal(filePath: string, now = Date.now()): EditorRevealRequest | null {
  const entry = pending.get(filePath)
  if (!entry) return null
  pending.delete(filePath)
  if (now - entry.at > REVEAL_TTL_MS) return null
  const { at: _at, ...req } = entry
  return req
}

/** 订阅定位请求（回调参数是目标 filePath），返回取消订阅函数 */
export function subscribeEditorReveal(listener: (filePath: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export interface ResolvedReveal {
  from: number
  to: number
  /** false：没找到命中文本，只能把光标放到原位置附近 */
  exact: boolean
}

/**
 * 把请求里的位置落到编辑器当前文档上：
 * 原位置文本仍一致就直接用；否则取离原位置最近的同一文本；都找不到则只返回钳制后的原位置。
 */
export function resolveRevealRange(
  doc: string,
  req: Pick<EditorRevealRequest, 'from' | 'to' | 'text' | 'caseSensitive'>,
): ResolvedReveal {
  const clamp = (n: number) => Math.max(0, Math.min(doc.length, Number.isFinite(n) ? Math.trunc(n) : 0))
  const from = clamp(req.from)
  if (!req.text) return { from, to: from, exact: false }

  const to = clamp(req.to)
  if (to > from && doc.slice(from, to) === req.text) return { from, to, exact: true }

  // 命中按位置递增：越过原位置后距离只会越来越大，找到拐点即可停止
  const matcher = buildLiteralMatcher(req.text, req.caseSensitive === true)
  let best: { from: number; to: number } | null = null
  let bestDist = Infinity
  let m: RegExpExecArray | null
  while ((m = matcher.exec(doc)) !== null) {
    const dist = Math.abs(m.index - from)
    if (dist < bestDist) {
      bestDist = dist
      best = { from: m.index, to: m.index + m[0].length }
    } else if (m.index > from) {
      break
    }
    if (m[0].length === 0) matcher.lastIndex++
  }
  return best ? { ...best, exact: true } : { from, to: from, exact: false }
}
