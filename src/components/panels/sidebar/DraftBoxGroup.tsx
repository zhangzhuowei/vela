/**
 * DraftBoxGroup — 草稿箱折叠组（含章节分组和单条草稿条目）
 *
 * 章节与草稿被拍平成单层行列表交给 WindowedList 做窗口化渲染：
 * 百章项目展开草稿箱不再一次性构建"章节数 × 版本数"个 DOM 节点。
 * 章节标题改为一次取回全部蓝图（原实现每个章节分组挂载时各打一次
 * db:blueprint-get，窗口化后行会随滚动反复挂载，逐章 IPC 会被放大）。
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, CheckCircle2, Circle, FileText, FolderOpen, Copy, Trash2, FilePen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DraftMeta } from '../../../stores/draft-store'
import { useDraftStore, readDraftBody } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { confirm } from '../../ui/Confirm'
import { DRAFT_STATUS_LABEL, DRAFT_STATUS_COLOR } from '../../../shared/draft-status'
import { showSidebarMenu } from './SidebarShared'
import { ipc } from '../../../services/ipc-client'
import WindowedList from '../../ui/WindowedList'
import { displayChapterNameSafe, type BranchLike } from '../../../shared/chapter-addressing'

// ===== 拍平后的行描述 =====

type DraftRow =
  | { kind: 'chapter'; chapterNumber: number; title: string; activeCount: number; hasFinalized: boolean; open: boolean }
  | { kind: 'draft'; draft: DraftMeta; chapterTitle: string; archived: boolean }
  | { kind: 'archived-toggle'; chapterNumber: number; count: number; shown: boolean }

/** 行高（px）：chapter 行用 .tree-item 的 26；draft 行 3+16+3；toggle 行紧凑单行 */
const ROW_HEIGHT: Record<DraftRow['kind'], number> = {
  'chapter': 26,
  'draft': 22,
  'archived-toggle': 20,
}

// ===== 草稿箱折叠组 =====

export default function DraftBoxGroup({
  draftsByChapter,
  branches = [],
}: {
  draftsByChapter: Record<number, DraftMeta[]>
  branches?: BranchLike[]
}) {
  const { t } = useTranslation('panels')
  const [open, setOpen] = useState(true)
  // 记"被收起"的章节：新章节默认展开
  const [closedChapters, setClosedChapters] = useState<Set<number>>(new Set())
  const [shownArchived, setShownArchived] = useState<Set<number>>(new Set())
  // 章节号 → 蓝图标题（一次取回全部）
  const [bpTitles, setBpTitles] = useState<Record<number, string>>({})

  useEffect(() => {
    let cancelled = false
    ipc.invoke('db:blueprint-get-all').then(bps => {
      if (cancelled || !Array.isArray(bps)) return
      const map: Record<number, string> = {}
      for (const bp of bps) {
        if (bp?.title) map[bp.chapterNumber] = bp.title
      }
      setBpTitles(map)
    }).catch(() => { })
    return () => { cancelled = true }
  }, [draftsByChapter])

  // 所有章节号排序
  const chapterNums = Object.keys(draftsByChapter)
    .map(Number)
    .sort((a, b) => a - b)

  // 筛选出包含非保留（活跃）草稿的实际章节数
  const activeChapterCount = chapterNums.filter(n =>
    (draftsByChapter[n] || []).some(d => d.status !== 'archived')
  ).length

  /** 章节显示名（蓝图标题优先，其次草稿携带的章节标题；前缀走 i18n） */
  const displayTitleOf = (chapterNumber: number, drafts: DraftMeta[]): string => {
    const baseTitle = bpTitles[chapterNumber] || drafts[0]?.chapterTitle || ''
    return displayChapterNameSafe(chapterNumber, branches, baseTitle)
  }

  // 拍平：章节行 + （展开时）活跃草稿行 + 归档切换行 + （显示时）归档草稿行
  const rows = useMemo<DraftRow[]>(() => {
    const list: DraftRow[] = []
    for (const chNum of chapterNums) {
      const drafts = draftsByChapter[chNum] || []
      const activeDrafts = drafts.filter(d => d.status !== 'archived')
      const archivedDrafts = drafts.filter(d => d.status === 'archived')
      const chapterOpen = !closedChapters.has(chNum)
      const title = displayTitleOf(chNum, drafts)

      list.push({
        kind: 'chapter',
        chapterNumber: chNum,
        title,
        activeCount: activeDrafts.length,
        hasFinalized: drafts.some(d => d.status === 'finalized'),
        open: chapterOpen,
      })
      if (!chapterOpen) continue

      for (const draft of activeDrafts) {
        list.push({ kind: 'draft', draft, chapterTitle: title, archived: false })
      }
      if (archivedDrafts.length > 0) {
        const shown = shownArchived.has(chNum)
        list.push({ kind: 'archived-toggle', chapterNumber: chNum, count: archivedDrafts.length, shown })
        if (shown) {
          for (const draft of archivedDrafts) {
            list.push({ kind: 'draft', draft, chapterTitle: title, archived: true })
          }
        }
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftsByChapter, closedChapters, shownArchived, bpTitles, branches])

  const toggleChapter = (chapterNumber: number) => {
    setClosedChapters(prev => {
      const next = new Set(prev)
      if (next.has(chapterNumber)) next.delete(chapterNumber)
      else next.add(chapterNumber)
      return next
    })
  }

  const toggleArchived = (chapterNumber: number) => {
    setShownArchived(prev => {
      const next = new Set(prev)
      if (next.has(chapterNumber)) next.delete(chapterNumber)
      else next.add(chapterNumber)
      return next
    })
  }

  const renderRow = (row: DraftRow) => {
    switch (row.kind) {
      case 'chapter':
        return (
          <div
            className="tree-item gap-1.5 cursor-pointer select-none"
            style={{ paddingLeft: 26 }}
            onClick={() => toggleChapter(row.chapterNumber)}
            title={row.title}
          >
            {row.open
              ? <ChevronDown size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
              : <ChevronRight size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            }
            {row.hasFinalized
              ? <CheckCircle2 size={10} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
              : <Circle size={6} style={{ flexShrink: 0, fill: 'transparent', stroke: 'var(--color-text-muted)' }} />
            }
            <span className="text-sm flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
              {row.title}
            </span>
            <span className="ml-auto text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              {t('drafts.draftsCount', { count: row.activeCount })}
            </span>
          </div>
        )
      case 'archived-toggle':
        return (
          <div
            className="flex items-center gap-1 cursor-pointer select-none h-full"
            style={{ paddingLeft: 54 }}
            onClick={() => toggleArchived(row.chapterNumber)}
          >
            <span className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
              {row.shown ? t('drafts.hide') : t('drafts.archived', { count: row.count })}
            </span>
          </div>
        )
      case 'draft':
        return (
          <DraftItem
            draft={row.draft}
            chapterTitleText={row.chapterTitle}
            archived={row.archived}
            t={t}
          />
        )
    }
  }

  return (
    <div>
      {/* 草稿箱标题行 */}
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
        title={t('draftBox.tooltip')}
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <FilePen size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{t('draftBox.title')}</span>
        {activeChapterCount > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {activeChapterCount} {t('chapters', { ns: 'common' })}
          </span>
        )}
      </div>

      {open && (
        <div>
          {chapterNums.length === 0 ? (
            <div
              className="text-xs py-1"
              style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}
            >
              {t('draftBox.noDrafts')}
            </div>
          ) : (
            <WindowedList
              items={rows}
              itemHeight={(row) => ROW_HEIGHT[row.kind]}
              renderItem={renderRow}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ===== 单条草稿条目 =====

function DraftItem({
  draft,
  chapterTitleText,
  archived = false,
  t,
}: {
  draft: DraftMeta
  chapterTitleText: string
  archived?: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  /** 打开草稿到编辑器 */
  const openDraft = async () => {
    const content = await readDraftBody(draft.filePath)
    useEditorStore.getState().openFile({
      id: draft.filePath,
      name: `${chapterTitleText} v${draft.version}`,
      type: 'chapter',
      filePath: draft.filePath,
      content,
    })
  }

  /** 将草稿标记为归档（软删除） */
  const deleteDraft = async () => {
    if (isFinalized) return
    const ok = await confirm(
      t('drafts.confirmArchive', { title: `${chapterTitleText} v${draft.version}` }),
      { title: t('drafts.confirmArchiveTitle'), confirmText: t('drafts.confirmArchiveBtn'), danger: true }
    )
    if (!ok) return
    await useDraftStore.getState().markDraftStatus(draft.filePath, draft.chapterNumber, 'archived')
  }

  const isFinalized = draft.status === 'finalized'

  return (
    <div
      className="relative flex items-center gap-1.5 cursor-pointer hover:bg-[var(--color-hover)]"
      style={{
        paddingLeft: 50,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        opacity: archived ? 0.45 : 1,
      }}
      onClick={openDraft}
      onContextMenu={e => showSidebarMenu([
        {
          key: 'open',
          label: t('drafts.openDraft'),
          icon: <FolderOpen size={13} />,
          onClick: openDraft,
        },
        { key: 'div1', type: 'divider' as const },
        {
          key: 'copy-path',
          label: t('drafts.copyFilePath'),
          icon: <Copy size={13} />,
          onClick: () => navigator.clipboard.writeText(draft.filePath).catch(() => { }),
        },
        { key: 'div2', type: 'divider' as const },
        {
          key: 'delete',
          label: t('drafts.deleteDraft'),
          icon: <Trash2 size={13} />,
          danger: true,
          disabled: isFinalized,
          onClick: deleteDraft,
        },
      ], e)}
      title={t('drafts.clickToOpenTitle', { title: `${chapterTitleText} v${draft.version}`, status: DRAFT_STATUS_LABEL[draft.status] || draft.status })}
    >
      <FileText size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
      <span className="text-xs flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
        {t('drafts.draftVersion', { version: draft.version })}
      </span>
      {/* 状态标签（始终显示） */}
      <span
        className="text-[0.7rem] flex-shrink-0"
        style={{ color: DRAFT_STATUS_COLOR[draft.status] || 'var(--color-text-muted)' }}
      >
        {DRAFT_STATUS_LABEL[draft.status] || draft.status}
      </span>
      {/* 已定稿图标 */}
      {isFinalized && (
        <CheckCircle2 size={10} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
      )}
    </div>
  )
}
