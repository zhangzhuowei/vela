/** 章末收束：书级默认 + 章级覆盖。缺省 cliffhanger，与旧写稿提示词一致。 */

export const CHAPTER_ENDINGS = ['cliffhanger', 'smooth'] as const
export type ChapterEnding = (typeof CHAPTER_ENDINGS)[number]

export function isChapterEnding(value: unknown): value is ChapterEnding {
  return value === 'cliffhanger' || value === 'smooth'
}

export function normalizeBookChapterEnding(value: unknown): ChapterEnding {
  return isChapterEnding(value) ? value : 'cliffhanger'
}

/** 空 / inherit / 非法 → 跟随书级 */
export function normalizeChapterEndingOverride(value: unknown): ChapterEnding | '' {
  return isChapterEnding(value) ? value : ''
}

export function resolveChapterEnding(book: unknown, chapter?: unknown): ChapterEnding {
  const override = normalizeChapterEndingOverride(chapter)
  if (override) return override
  return normalizeBookChapterEnding(book)
}
