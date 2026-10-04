/**
 * 字面量文本匹配 — 主进程全局搜索与渲染端编辑器定位共用
 *
 * 用户输入一律按字面量处理（不是正则）。不区分大小写时用正则的 i + u 标志做
 * Unicode 简单大小写折叠：它不改变字符串长度，命中偏移可以直接对应回原文；
 * 先 toLowerCase() 再 indexOf 在个别字符（如 'İ'）上会改变长度，偏移会错位。
 */

/** 转义正则元字符。只转义语法字符，u 模式下多余的转义会报错 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 构造全局字面量匹配器（带 g 标志，调用方用 exec 循环时注意 lastIndex） */
export function buildLiteralMatcher(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(escapeRegExp(query), caseSensitive ? 'gu' : 'giu')
}

/**
 * 统一换行为 \n。CodeMirror 按 \r\n / \r / \n 分行、文档坐标里每个换行只算 1，
 * 主进程按统一后的文本计算偏移，编辑器里才能对上。
 */
export function normalizeLineEndings(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}
