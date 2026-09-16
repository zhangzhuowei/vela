import type { RefLineData, RefStageData, RefFunc } from '../../../electron/repositories/reference-repository'
import type { LineMatrix as LineMatrixData } from '../../services/reference/line-matrix'
import { computeLineStats } from '../../services/reference/line-matrix'

const FUNC_COLOR: Record<RefFunc, string> = {
  main: 'var(--color-accent)',
  daily: 'var(--color-text-muted)',
  assist: '#4c8dff',
  introduce: '#ff9f43',
  mention: 'rgba(128,128,128,0.3)',
}

interface Props {
  matrix: LineMatrixData
  lines: RefLineData[]
  stages: RefStageData[]
  onCellClick?: (chapter: number) => void
}

export default function LineMatrix({ matrix, lines, stages, onCellClick }: Props) {
  const colWidth = Math.max(3, Math.min(10, Math.floor(900 / Math.max(1, matrix.chapters.length))))
  const stats = computeLineStats(matrix)
  const switchSet = new Set(stats.switchPoints.map((p) => p.chapter))
  const nameOf = (id: number) => lines.find((l) => l.id === id)?.name ?? String(id)
  const stageOf = (ch: number) => stages.find((s) => ch >= s.fromChapter && ch <= s.toChapter)

  return (
    <div className="overflow-x-auto">
      {stages.length > 0 && (
        <div className="flex h-5 mb-1" style={{ minWidth: matrix.chapters.length * colWidth }}>
          {stages.map((s) => {
            const count = matrix.chapters.filter((c) => c >= s.fromChapter && c <= s.toChapter).length
            if (count === 0) return null
            return (
              <div
                key={s.id}
                className="h-full text-[0.6rem] truncate px-0.5 leading-5 text-[var(--color-text-muted)] border-r border-[var(--color-border)]"
                style={{ width: count * colWidth }}
                title={`${s.seq} ${s.title}`}
              >
                {s.seq} {s.title}
              </div>
            )
          })}
        </div>
      )}
      {matrix.rows.map((row) => (
        <div key={row.lineId} className="flex items-center gap-2 mb-0.5">
          <span className="w-16 flex-shrink-0 text-[0.65rem] truncate text-[var(--color-text-muted)]">{nameOf(row.lineId)}</span>
          <div className="flex" style={{ minWidth: matrix.chapters.length * colWidth }}>
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
    </div>
  )
}
