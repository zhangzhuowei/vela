/**
 * ManuscriptGroup — 正文章节折叠组（已定稿章节列表）
 */

import { useState, useEffect } from 'react'
import { ChevronRight, ChevronDown, FileText, FolderOpen, Copy, PenTool } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FileNode } from '../../../shared/ipc-channels'
import { ipc } from '../../../services/ipc-client'

import { showSidebarMenu, openChapterFile } from './SidebarShared'
import WindowedList from '../../ui/WindowedList'

// ===== 章节标题缓存 =====

/** 章节标题内存缓存：path → 显示名（进程内常驻，避免大量重复 IPC 读取） */
export const chapterTitleCache = new Map<string, string>()

/** 清除特定文件的章节标题缓存 */
export function clearChapterTitleCache(filePath?: string) {
  if (filePath) {
    chapterTitleCache.delete(filePath)
  } else {
    chapterTitleCache.clear()
  }
}

/**
 * 兜底标题：读取正文首行（仅在蓝图无标题时使用）
 */
async function readTitleFromContent(filePath: string, fallback: string): Promise<string> {
  let fileContent = ''
  if (filePath.startsWith('vela://')) {
    const { readVelaContent } = await import('../../../services/vela-protocol')
    fileContent = await readVelaContent(filePath)
  } else {
    const result = await ipc.invoke('fs:read-file', filePath)
    if (result.success) fileContent = result.content
  }

  if (!fileContent) return fallback
  const firstLine = fileContent.split('\n').find((l: string) => l.trim())
  if (!firstLine) return fallback
  const title = firstLine.replace(/^#+\s*/, '').trim()
  const display = title || fallback
  chapterTitleCache.set(filePath, display)
  return display
}

// ===== 正文章节组件 =====

export default function ManuscriptGroup({ files }: { files: FileNode[]; projectPath: string }) {
  const { t } = useTranslation('panels')
  const [open, setOpen] = useState(true)
  // 文件路径 → 显示名称的映射（异步加载）
  const [titleMap, setTitleMap] = useState<Record<string, string>>({})

  // files 变化时异步补齐标题。
  // 蓝图标题一次取回全部：原实现每个文件各打一次 db:blueprint-get，
  // 百章项目挂载一次侧栏就是上百次 IPC；正文首行只作为无蓝图时的兜底。
  // 依赖只挂路径指纹：files 数组在父组件每次渲染都是新引用，titleMap
  // 进依赖会导致每次写入 state 后 effect 立即重跑（流式期间反复空转）
  const filesDep = files.map(f => f.path).join(',')
  useEffect(() => {
    if (files.length === 0) return
    let cancelled = false
    const load = async () => {
      const chapterFiles = files.filter(f => !f.name.includes('_notes'))
      const missing = chapterFiles.filter(f => !chapterTitleCache.has(f.path))
      const entries: Record<string, string> = {}

      if (missing.length > 0) {
        let bpTitleByChapter = new Map<number, string>()
        try {
          const bps = await ipc.invoke('db:blueprint-get-all')
          bpTitleByChapter = new Map(
            (bps || []).filter(b => b?.title).map(b => [b.chapterNumber, `第${b.chapterNumber}章 ${b.title}`])
          )
        } catch { /* 蓝图读取失败时全部走正文首行兜底 */ }

        await Promise.all(
          missing.map(async (f) => {
            const rawName = f.name.replace(/\.[^.]+$/, '')
            const chMatch = rawName.match(/^chapter_(\d+)$/)
            const chNum = chMatch ? parseInt(chMatch[1], 10) : undefined
            const fallback = chNum ? `第${chNum}章` : rawName
            const fromBp = chNum != null ? bpTitleByChapter.get(chNum) : undefined
            if (fromBp) {
              chapterTitleCache.set(f.path, fromBp)
              entries[f.path] = fromBp
            } else {
              entries[f.path] = await readTitleFromContent(f.path, fallback)
            }
          })
        )
      }

      // 命中常驻缓存但尚未进本次挂载 state 的路径一并回填
      for (const f of chapterFiles) {
        if (!entries[f.path] && chapterTitleCache.has(f.path)) {
          entries[f.path] = chapterTitleCache.get(f.path)!
        }
      }

      if (!cancelled && Object.keys(entries).length > 0) {
        setTitleMap(prev => ({ ...prev, ...entries }))
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesDep])

  const getDisplay = (f: FileNode) => {
    if (titleMap[f.path]) return titleMap[f.path]
    const rawName = f.name.replace(/\.[^.]+$/, '')
    const chMatch = rawName.match(/^chapter_(\d+)$/)
    return chMatch ? `第${parseInt(chMatch[1], 10)}章` : rawName
  }

  // 只显示正文章节（过滤掉旧的 _notes 文件）
  const chapterFiles = files.filter(f => !f.name.includes('_notes'))

  return (
    <div>
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <PenTool size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{t('manuscript.chapters')}</span>
        {chapterFiles.length > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {chapterFiles.length} {t('chapters', { ns: 'common' })}
          </span>
        )}
      </div>
      {open && (
        <div>
          {chapterFiles.length === 0 ? (
            <div className="text-xs py-1" style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}>
              {t('manuscript.noFinalizedChapters')}
            </div>
          ) : (
            <WindowedList
              items={chapterFiles}
              itemHeight={26}
              renderItem={(f) => {
                const displayName = getDisplay(f)
                return (
                  <div
                    className="tree-item gap-1.5 cursor-pointer"
                    style={{ paddingLeft: 30 }}
                    onClick={() => openChapterFile(f.path, displayName)}
                    onContextMenu={e => showSidebarMenu([
                      {
                        key: 'open',
                        label: t('manuscript.openChapter'),
                        icon: <FolderOpen size={13} />,
                        onClick: () => openChapterFile(f.path, displayName),
                      },
                      { key: 'div1', type: 'divider' as const },
                      {
                        key: 'copy-path',
                        label: t('manuscript.copyPath'),
                        icon: <Copy size={13} />,
                        onClick: () => navigator.clipboard.writeText(f.path).catch(() => { }),
                      },
                    ], e)}
                    title={`${t('manuscript.clickToOpen')} — ${displayName}`}
                  >
                    <FileText size={11} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                    <span className="text-sm truncate" style={{ color: 'var(--color-text-secondary)' }}>
                      {displayName}
                    </span>
                  </div>
                )
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
