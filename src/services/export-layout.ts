import {
  branchIdOf, displayChapterNameSafe, isMainChapter, type BranchLike,
} from '../shared/chapter-addressing'

export type ExtraExportMode = 'appendix' | 'inline' | 'separate'

export interface LayoutBranch extends BranchLike {
  sortOrder?: number
}

export interface LayoutChapter {
  chapterNumber: number
  title: string
  content: string
}

export interface LaidOutChapter extends LayoutChapter {
  /** 若有，导出时在本章前插入该节标题（如「番外」） */
  section?: string
}

export interface ExportDocument {
  fileStem: string
  chapters: LaidOutChapter[]
}

export function normalizeExtraExportMode(v: unknown): ExtraExportMode {
  return v === 'inline' || v === 'separate' ? v : 'appendix'
}

function safeStem(s: string): string {
  const t = s.replace(/[/\\:*?"<>|]/g, '_').trim()
  return t || 'untitled'
}

function byChapter(a: LayoutChapter, b: LayoutChapter): number {
  return a.chapterNumber - b.chapterNumber
}

function byFileOrder(a: LayoutBranch, b: LayoutBranch): number {
  const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  return so !== 0 ? so : a.id - b.id
}

function byAppendixOrder(a: LayoutBranch, b: LayoutBranch): number {
  if (a.anchorChapter !== b.anchorChapter) return a.anchorChapter - b.anchorChapter
  return byFileOrder(a, b)
}

function named(ch: LayoutChapter, branches: LayoutBranch[]): LaidOutChapter {
  return {
    chapterNumber: ch.chapterNumber,
    title: displayChapterNameSafe(ch.chapterNumber, branches, ch.title),
    content: ch.content,
  }
}

function chaptersOf(branchId: number, chapters: LayoutChapter[]): LayoutChapter[] {
  return chapters.filter((c) => branchIdOf(c.chapterNumber) === branchId).sort(byChapter)
}

function leftoverChapters(
  chapters: LayoutChapter[],
  branches: LayoutBranch[],
  includeIf: boolean,
): LayoutChapter[] {
  const known = new Map(branches.map((b) => [b.id, b]))
  return chapters.filter((c) => {
    const id = branchIdOf(c.chapterNumber)
    if (id === 0) return false
    const b = known.get(id)
    if (!b) return true
    if (b.kind === 'if' && !includeIf) return false
    return false
  }).sort(byChapter)
}

function leftoverDocument(
  bookName: string,
  chapters: LayoutChapter[],
  branches: LayoutBranch[],
  includeIf: boolean,
): ExportDocument[] {
  const leftover = leftoverChapters(chapters, branches, includeIf)
  if (leftover.length === 0) return []
  const namedChs = leftover.map((c) => named(c, branches))
  namedChs[0] = { ...namedChs[0], section: '未登记线' }
  return [{ fileStem: safeStem(`${bookName}·未登记线`), chapters: namedChs }]
}

function groupsOf(
  kind: 'extra' | 'if',
  chapters: LayoutChapter[],
  branches: LayoutBranch[],
  cmp: (a: LayoutBranch, b: LayoutBranch) => number,
): Array<{ branch: LayoutBranch; chapters: LayoutChapter[] }> {
  return branches
    .filter((b) => b.kind === kind)
    .slice()
    .sort(cmp)
    .map((branch) => ({ branch, chapters: chaptersOf(branch.id, chapters) }))
    .filter((g) => g.chapters.length > 0)
}

function ifDocuments(
  bookName: string,
  chapters: LayoutChapter[],
  branches: LayoutBranch[],
  includeIf: boolean,
): ExportDocument[] {
  if (!includeIf) return []
  return groupsOf('if', chapters, branches, byFileOrder).map(({ branch, chapters: chs }) => ({
    fileStem: safeStem(`${bookName}·IF·${branch.name}`),
    chapters: chs.map((c) => named(c, branches)),
  }))
}

function inlineBody(main: LayoutChapter[], extras: Array<{ branch: LayoutBranch; chapters: LayoutChapter[] }>, branches: LayoutBranch[]): LaidOutChapter[] {
  const extrasByAnchor = new Map<number, LaidOutChapter[]>()
  for (const { branch, chapters: chs } of extras) {
    const list = extrasByAnchor.get(branch.anchorChapter) ?? []
    list.push(...chs.map((c) => named(c, branches)))
    extrasByAnchor.set(branch.anchorChapter, list)
  }
  const used = new Set<number>()
  const take = (anchor: number): LaidOutChapter[] => {
    const list = extrasByAnchor.get(anchor) ?? []
    for (const c of list) used.add(c.chapterNumber)
    return list
  }
  const body: LaidOutChapter[] = [...take(0)]
  for (const ch of main) {
    body.push(named(ch, branches))
    body.push(...take(ch.chapterNumber))
  }
  for (const { chapters: chs } of extras) {
    for (const c of chs) {
      if (!used.has(c.chapterNumber)) body.push(named(c, branches))
    }
  }
  return body
}

/** 按正文 / 番外 / IF 分流成若干导出文档。IF 始终单独成文。 */
export function layoutExportDocuments(
  bookName: string,
  chapters: LayoutChapter[],
  branches: LayoutBranch[],
  extraMode: ExtraExportMode,
  includeIf = true,
): ExportDocument[] {
  const stem = safeStem(bookName)
  const main = chapters.filter((c) => isMainChapter(c.chapterNumber)).sort(byChapter)
  const extrasForFiles = groupsOf('extra', chapters, branches, byFileOrder)
  const extrasForAppendix = groupsOf('extra', chapters, branches, byAppendixOrder)
  const docs: ExportDocument[] = []

  if (extraMode === 'separate') {
    if (main.length > 0) {
      docs.push({ fileStem: stem, chapters: main.map((c) => named(c, branches)) })
    }
    for (const { branch, chapters: chs } of extrasForFiles) {
      docs.push({
        fileStem: safeStem(`${stem}·番外·${branch.name}`),
        chapters: chs.map((c) => named(c, branches)),
      })
    }
    docs.push(...ifDocuments(stem, chapters, branches, includeIf))
    docs.push(...leftoverDocument(stem, chapters, branches, includeIf))
    return docs
  }

  const body = extraMode === 'inline'
    ? inlineBody(main, extrasForAppendix, branches)
    : (() => {
      const extraChs: LaidOutChapter[] = extrasForAppendix.flatMap(({ chapters: chs }) => chs.map((c) => named(c, branches)))
      if (extraChs.length > 0) extraChs[0] = { ...extraChs[0], section: '番外' }
      return [...main.map((c) => named(c, branches)), ...extraChs]
    })()

  if (body.length > 0) docs.push({ fileStem: stem, chapters: body })
  docs.push(...ifDocuments(stem, chapters, branches, includeIf))
  docs.push(...leftoverDocument(stem, chapters, branches, includeIf))
  return docs
}
