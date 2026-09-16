import { ipc } from '../ipc-client'
import { globalEventBus } from '../../shared/event-bus'
import {
  visibilityFor, previousChapterNumber, displayChapterNameSafe, chapterFileName, branchOf, isMainChapter,
  type ChapterVisibility, type BranchLike,
} from '../../shared/chapter-addressing'
import type { BranchData } from '../../../electron/repositories/branch-repository'

let cache: BranchData[] | null = null

globalEventBus.on('REFRESH_RESOURCE', ({ resources }) => {
  if (resources.includes('branches') || resources.includes('all')) cache = null
})

export function invalidateBranchCache(): void { cache = null }

export async function getBranches(): Promise<BranchData[]> {
  if (cache) return cache
  cache = await ipc.invoke('db:branch-list').catch(() => [] as BranchData[])
  return cache
}

export async function resolveVisibility(chapterNumber: number): Promise<ChapterVisibility> {
  if (isMainChapter(chapterNumber)) return visibilityFor(chapterNumber, [])
  return visibilityFor(chapterNumber, await getBranches())
}

export async function resolveBranch(chapterNumber: number): Promise<BranchData | null> {
  if (isMainChapter(chapterNumber)) return null
  return branchOf(chapterNumber, await getBranches()) as BranchData | null
}

export async function resolvePreviousChapter(chapterNumber: number): Promise<number | null> {
  return previousChapterNumber(chapterNumber, isMainChapter(chapterNumber) ? [] : await getBranches())
}

export async function resolveDisplayName(chapterNumber: number, title = ''): Promise<string> {
  return displayChapterNameSafe(chapterNumber, isMainChapter(chapterNumber) ? [] : await getBranches(), title)
}

export async function resolveFileName(chapterNumber: number, title = ''): Promise<string> {
  return chapterFileName(chapterNumber, isMainChapter(chapterNumber) ? [] : await getBranches(), title)
}

/** 线前提 + 设定差异，写稿 / 目录生成时拼进全局指导（正文返回空串） */
export function branchGuidanceBlock(b: (BranchLike & { premise: string; settingDiff: string }) | null): string {
  if (!b) return ''
  const head = b.kind === 'extra'
    ? `【本线为番外「${b.name}」，发生在${b.anchorChapter > 0 ? `正文第 ${b.anchorChapter} 章之后` : '正文开始之前'}；不得改变正史既定事实】`
    : `【本线为 IF 线「${b.name}」，自正文第 ${b.anchorChapter} 章分叉；分叉后的走向以本线为准】`
  return [head, b.premise ? `前提：${b.premise}` : '', b.settingDiff ? `与正史的设定差异（优先级高于角色事实）：\n${b.settingDiff}` : '']
    .filter(Boolean).join('\n')
}
