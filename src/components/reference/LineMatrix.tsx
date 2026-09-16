import { useTranslation } from 'react-i18next'
import type { RefLineData, RefStageData, RefFunc } from '../../../electron/repositories/reference-repository'
import type { LineMatrix as LineMatrixData } from '../../services/reference/line-matrix'
import { computeLineStats } from '../../services/reference/line-matrix'

const LABEL_WIDTH = 88

const FUNC_COLOR: Record<RefFunc, string> = {
  main: 'var(--color-accent)',
  daily: 'var(--color-text-muted)',
  assist: '#4c8dff',
  introduce: '#ff9f43',
  mention: 'rgba(128,128,128,0.45)',
}

function cellWidth(chapterCount: number) {
  return Math.max(8, Math.min(24, Math.floor(560 / Math.max(1, chapterCount))))
}

interface Props {
  matrix: LineMatrixData
  lines: RefLineData[]
  stages: RefStageData[]
  onCellClick?: (chapter: number) => void
}

export default function LineMatrix({ matrix, lines, stages, onCellClick }: Props) {
  const { t } = useTranslation('pages')
  const colWidth = cellWidth(matrix.chapters.length)
  const gridWidth = matrix.chapters.length * colWidth
  const stats = computeLineStats(matrix)
  const switchSet = new Set(stats.switchPoints.map((p) => p.chapter))
  const nameOf = (id: number) => lines.find((l) => l.id === id)?.name ?? String(id)
  const stageOf = (ch: number) => stages.find((s) => ch >= s.fromChapter && ch <= s.toChapter)
  const showChapterNumbers = colWidth >= 14

  const legend: Array<{ key: string; color: string }> = [
    { key: 'main', color: FUNC_COLOR.main },
    { key: 'daily', color: FUNC_COLOR.daily },
    { key: 'assist', color: FUNC_COLOR.assist },
    { key: 'introduce', color: FUNC_COLOR.introduce },
    { key: 'mention', color: FUNC_COLOR.mention },
  ]

  return (
    <div className="overflow-x-auto">
      {stages.length > 0 && (
        <div className="flex items-stretch h-5 mb-0.5">
          <span className="flex-shrink-0" style={{ width: LABEL_WIDTH }} />
          <div className="flex" style={{ minWidth: gridWidth }}>
            {stages.map((s) => {
              const count = matrix.chapters.filter((c) => c >= s.fromChapter && c <= s.toChapter).length
              if (count === 0) return null
              const w = count * colWidth
              return (
                <div
                  key={s.id}
                  className="h-full text-[0.6rem] truncate px-0.5 leading-5 text-[var(--color-text-muted)] border-r border-[var(--color-border)]"
                  style={{ width: w, minWidth: w }}
                  title={`${s.seq} ${s.title}（第${s.fromChapter}～${s.toChapter}章）`}
                >
                  {w >= 36 ? `${s.seq} ${s.title}` : String(s.seq)}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {showChapterNumbers && (
        <div className="flex items-center mb-0.5">
          <span className="flex-shrink-0" style={{ width: LABEL_WIDTH }} />
          <div className="flex" style={{ minWidth: gridWidth }}>
            {matrix.chapters.map((ch) => (
              <span
                key={ch}
                className="text-[0.55rem] leading-3 text-center text-[var(--color-text-muted)] tabular-nums"
                style={{ width: colWidth }}
              >
                {ch}
              </span>
            ))}
          </div>
        </div>
      )}
      {matrix.rows.map((row) => (
        <div key={row.lineId} className="flex items-center mb-0.5">
          <span
            className="flex-shrink-0 text-[0.65rem] truncate pr-2 text-[var(--color-text-muted)]"
            style={{ width: LABEL_WIDTH }}
            title={nameOf(row.lineId)}
          >
            {nameOf(row.lineId)}
          </span>
          <div className="flex" style={{ minWidth: gridWidth }}>
            {row.cells.map((cell, i) => {
              const ch = matrix.chapters[i]
              const st = stageOf(ch)
              const active = matrix.activeLineIds[i] === row.lineId
              return (
                <button
                  key={ch}
                  type="button"
                  title={`第${ch}章｜${st?.title ?? '—'}｜${cell?.func ?? '—'}`}
                  className="relative h-4 p-0 border-0"
                  style={{
                    width: colWidth,
                    backgroundColor: cell ? FUNC_COLOR[cell.func] : 'transparent',
                    outline: active ? '1px solid var(--color-text)' : undefined,
                    outlineOffset: -1,
                  }}
                  onClick={() => onCellClick?.(ch)}
                >
                  {cell?.intimate && (
                    <span className="absolute left-0 right-0 bottom-0 h-0.5" style={{ backgroundColor: '#f472b6' }} />
                  )}
                  {switchSet.has(ch) && (
                    <span className="absolute top-0 bottom-0 left-0 border-l border-dashed border-[var(--color-text-muted)]" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[0.6rem] text-[var(--color-text-muted)]">
        {legend.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
            {t(`reference.outline.matrix.${item.key}`)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-0.5" style={{ backgroundColor: '#f472b6' }} />
          {t('reference.outline.matrix.intimate')}
        </span>
      </div>
    </div>
  )
}
