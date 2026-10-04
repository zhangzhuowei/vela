/**
 * 提示缓存分段标记（渲染进程与主进程共用）
 *
 * PromptBuilder 在填入 Canon 上下文时，用这对不可见字符把它圈出来。
 * - Anthropic 原生协议：主进程把圈出的 Canon 上下文提到 system 开头并打上 cache_control。
 *   同一章节的写稿 / 精修 / 审稿 / 修稿用的是同一份 Canon 上下文，后续请求按缓存价读取这段前缀。
 * - 其他协议：主进程发送前把标记去掉，模型看到的内容与以前完全一致。
 */

/** 段首标记：INVISIBLE SEPARATOR + INVISIBLE PLUS + INVISIBLE SEPARATOR */
export const CACHEABLE_START = '\u2063\u2064\u2063'
/** 段尾标记：INVISIBLE PLUS + INVISIBLE SEPARATOR + INVISIBLE PLUS */
export const CACHEABLE_END = '\u2064\u2063\u2064'

/** 把一段内容标记为可缓存（空内容不标记） */
export function markCacheable(text: string): string {
  return text ? `${CACHEABLE_START}${text}${CACHEABLE_END}` : text
}

/** 去掉全部标记 */
export function stripCacheMarkers(text: string): string {
  if (!text || (!text.includes(CACHEABLE_START) && !text.includes(CACHEABLE_END))) return text
  return text.split(CACHEABLE_START).join('').split(CACHEABLE_END).join('')
}

/** 取出第一段成对标记圈住的内容；没有成对标记时返回 null */
export function extractCacheable(text: string): { before: string; segment: string; after: string } | null {
  if (!text) return null
  const start = text.indexOf(CACHEABLE_START)
  if (start < 0) return null
  const end = text.indexOf(CACHEABLE_END, start + CACHEABLE_START.length)
  if (end < 0) return null
  return {
    before: text.slice(0, start),
    segment: text.slice(start + CACHEABLE_START.length, end),
    after: text.slice(end + CACHEABLE_END.length),
  }
}
