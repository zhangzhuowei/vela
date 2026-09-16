/** L0 单次送入的正文字数上限；超过则切两半各跑一次再合并 */
export const DIGEST_MAX_CHARS = 8000
/** L1 阶段切分时每批送入的章摘要数 */
export const STAGE_BATCH_SIZE = 100
export const DIGEST_CONCURRENCY = 3

export interface RefRange { from: number; to: number }

export interface ReferenceCostEstimate {
  chapterCount: number
  digestCalls: number
  upperCalls: number
  estimatedTokens: number
  estimatedMinutes: number
}

export function estimateReferenceCost(
  chapters: Array<{ number: number; wordCount: number }>,
  range: RefRange,
): ReferenceCostEstimate {
  const inRange = chapters.filter((c) => c.number >= range.from && c.number <= range.to)
  const digestCalls = inRange.reduce((n, c) => n + (c.wordCount > DIGEST_MAX_CHARS ? 2 : 1), 0)
  const stageBatches = Math.ceil(inRange.length / STAGE_BATCH_SIZE)
  const upperCalls = stageBatches + 2 // 阶段批次 + L2 + L3（线弧按线数另计，量小忽略）
  const digestTokens = inRange.reduce((n, c) => n + Math.min(c.wordCount, DIGEST_MAX_CHARS) * 1.2 + 600, 0)
  const upperTokens = upperCalls * 12000
  const estimatedTokens = Math.round(digestTokens + upperTokens)
  const digestSeconds = (digestCalls / DIGEST_CONCURRENCY) * 20
  const upperSeconds = upperCalls * 40
  return {
    chapterCount: inRange.length,
    digestCalls,
    upperCalls,
    estimatedTokens,
    estimatedMinutes: Math.ceil((digestSeconds + upperSeconds) / 60),
  }
}
