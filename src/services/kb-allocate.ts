/**
 * 知识库召回的名额分配（纯函数）
 *
 * 写稿 / 对话 / 审稿都只取前几段。词表类文档双字组密度极高，肉戏场景里
 * 会把设定和已写正文全部挤出去。做法：多取几倍再按文件名前缀分桶，
 * 每桶先拿保底名额，剩下的位子按原排名补齐。不改检索算法。
 */

export type KbKind = 'setting' | 'wordlist' | 'other'

export interface KbHit {
  fileName: string
  text: string
  score: number
}

/** 与设定纲要同步、词表整理产出的文件名前缀约定 */
export const KB_SETTING_PREFIX = '设定·'
export const KB_WORDLIST_PREFIXES = ['词表·', '写法示例·', '基础动作定义', '姿势详解']

export function kbKindOf(fileName: string): KbKind {
  const name = (fileName || '').trim()
  if (name.startsWith(KB_SETTING_PREFIX)) return 'setting'
  if (KB_WORDLIST_PREFIXES.some((p) => name.startsWith(p))) return 'wordlist'
  return 'other'
}

/** 整理产出里标明「不导入」的菜单/决策表，选中后也要挡掉 */
export function isBlockedKbImportName(filePathOrName: string): boolean {
  const name = (filePathOrName || '').replace(/\\/g, '/').split('/').pop() || ''
  return /不导入/.test(name)
}

export interface KBChunkPreview {
  id: string
  chunkIndex: number
  totalChunks: number
  text: string
  fileName: string
}

/** 把 LanceDB 行收成按 chunkIndex 排序的预览切片 */
export function normalizeKbChunks(rows: Array<Partial<KBChunkPreview>>): KBChunkPreview[] {
  return rows
    .map((r, i) => ({
      id: String(r.id ?? i),
      chunkIndex: Number(r.chunkIndex ?? i),
      totalChunks: Number(r.totalChunks ?? rows.length),
      text: String(r.text ?? ''),
      fileName: String(r.fileName ?? ''),
    }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
}

/** 取 topK 时向底层多要几倍，才有东西可分 */
export function kbOverfetch(topK: number): number {
  return Math.min(Math.max(topK * 3, topK), 15)
}

/** 保底名额：设定 2、词表 1，其余留给正文与手导资料；topK 小于 5 时按比例缩 */
export function kbQuota(topK: number): Record<KbKind, number> {
  if (topK >= 5) return { setting: 2, wordlist: 1, other: topK - 3 }
  if (topK === 4) return { setting: 1, wordlist: 1, other: 2 }
  if (topK === 3) return { setting: 1, wordlist: 0, other: 2 }
  return { setting: 0, wordlist: 0, other: Math.max(topK, 0) }
}

/**
 * 按名额挑出 topK 段：先每桶拿保底，再按原排名补空位。
 * 结果保持原排名顺序，方便提示词里 [1][2] 编号和分数一致。
 */
export function allocateKbHits<T extends KbHit>(hits: T[], topK: number): T[] {
  if (hits.length <= topK) return hits
  const quota = kbQuota(topK)
  const used: Record<KbKind, number> = { setting: 0, wordlist: 0, other: 0 }
  const picked = new Set<T>()
  for (const h of hits) {
    const kind = kbKindOf(h.fileName)
    if (used[kind] < quota[kind]) {
      used[kind]++
      picked.add(h)
    }
  }
  for (const h of hits) {
    if (picked.size >= topK) break
    if (!picked.has(h)) picked.add(h)
  }
  return hits.filter((h) => picked.has(h)).slice(0, topK)
}

/** 召回里含词表段时贴在参考资料后面的一句话；没有词表则空串 */
export function wordlistUsageNote(hits: Array<{ fileName: string }>): string {
  return hits.some((h) => kbKindOf(h.fileName) === 'wordlist')
    ? '（以上带「词表」「写法示例」「基础动作」「姿势」字样的资料只是可选词汇与示范：每段最多选用少量词语，不得连续罗列、不得照抄整行，人物、视角、语气一律按本书。）'
    : ''
}
