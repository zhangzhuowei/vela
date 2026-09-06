/**
 * 正文落盘前的机械清洗：思维链标签、一致性闸门留下的编辑标注。
 * 不改情节，只删不该出现在小说里的元注释。
 */

const EDITORIAL_MARKERS = /[（(]据前文线索[）)]/g

export function stripEditorialMarkers(text: string): string {
  if (!text) return text
  return text.replace(EDITORIAL_MARKERS, '')
}

export function stripThinkingTags(text: string): string {
  if (!text) return text
  return stripEditorialMarkers(text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')).trim()
}
