import type { RefDigestData, RefLineData, RefFunc, RefStage } from '../../../electron/repositories/reference-repository'

export interface LineCell { stage: RefStage; func: RefFunc; intimate: boolean }
export interface LineRow { lineId: number; cells: Array<LineCell | null> }
export interface LineMatrix { chapters: number[]; rows: LineRow[]; activeLineIds: Array<number | null> }

export interface LineStat {
  lineId: number
  firstChapter: number | null
  lastMainChapter: number | null
  mainCount: number
  dailyCount: number
  assistCount: number
  introduceCount: number
  mentionCount: number
  intimateCount: number
  maxGap: number
}
export interface SwitchPoint { chapter: number; fromLineId: number; toLineId: number }
export interface LineStats { perLine: LineStat[]; switchPoints: SwitchPoint[]; avgMainRun: number }

export interface LineCandidate { name: string; firstChapter: number; mainCount: number; introduceCount: number; total: number; score: number }

export function normalizeName(name: string, lines: RefLineData[]): number | null {
  const key = name.trim()
  if (!key) return null
  for (const l of lines) {
    if (l.name === key || l.aliases.includes(key)) return l.id
  }
  return null
}

export function buildLineMatrix(digests: RefDigestData[], lines: RefLineData[]): LineMatrix {
  const ok = digests.filter((d) => d.status === 'ok').sort((a, b) => a.chapterNumber - b.chapterNumber)
  const chapters = ok.map((d) => d.chapterNumber)
  const rows: LineRow[] = lines.map((l) => ({ lineId: l.id, cells: chapters.map(() => null) }))
  const idx = new Map(lines.map((l, i) => [l.id, i]))
  const activeLineIds: Array<number | null> = []
  ok.forEach((d, col) => {
    for (const s of d.characterStates) {
      const id = normalizeName(s.name, lines)
      if (id === null) continue
      const row = rows[idx.get(id)!]
      const prev = row.cells[col]
      // 同章同人多条记录：main 优先，其次保留先出现的
      if (!prev || (prev.func !== 'main' && s.func === 'main')) {
        row.cells[col] = { stage: s.stage, func: s.func, intimate: d.intimate }
      }
    }
    activeLineIds.push(normalizeName(d.activeLine, lines))
  })
  return { chapters, rows, activeLineIds }
}

export function computeLineStats(m: LineMatrix): LineStats {
  const perLine: LineStat[] = m.rows.map((row) => {
    const stat: LineStat = {
      lineId: row.lineId, firstChapter: null, lastMainChapter: null,
      mainCount: 0, dailyCount: 0, assistCount: 0, introduceCount: 0, mentionCount: 0, intimateCount: 0, maxGap: 0,
    }
    let lastSeen: number | null = null
    row.cells.forEach((cell, i) => {
      if (!cell) return
      const ch = m.chapters[i]
      if (stat.firstChapter === null) stat.firstChapter = ch
      if (lastSeen !== null) stat.maxGap = Math.max(stat.maxGap, ch - lastSeen)
      lastSeen = ch
      if (cell.func === 'main') { stat.mainCount++; stat.lastMainChapter = ch }
      if (cell.func === 'daily') stat.dailyCount++
      if (cell.func === 'assist') stat.assistCount++
      if (cell.func === 'introduce') stat.introduceCount++
      if (cell.func === 'mention') stat.mentionCount++
      if (cell.intimate && cell.func === 'main') stat.intimateCount++
    })
    return stat
  })

  const switchPoints: SwitchPoint[] = []
  const runs: number[] = []
  let cur: number | null = null
  let run = 0
  m.activeLineIds.forEach((id, i) => {
    if (id === null) return
    if (cur === null) { cur = id; run = 1; return }
    if (id === cur) { run++; return }
    switchPoints.push({ chapter: m.chapters[i], fromLineId: cur, toLineId: id })
    runs.push(run)
    cur = id
    run = 1
  })
  if (cur !== null) runs.push(run)
  const avgMainRun = runs.length ? Math.round((runs.reduce((a, b) => a + b, 0) / runs.length) * 10) / 10 : 0
  return { perLine, switchPoints, avgMainRun }
}

export function suggestLineCandidates(digests: RefDigestData[]): LineCandidate[] {
  const map = new Map<string, LineCandidate>()
  for (const d of digests.filter((x) => x.status === 'ok').sort((a, b) => a.chapterNumber - b.chapterNumber)) {
    for (const s of d.characterStates) {
      const name = s.name.trim()
      if (!name) continue
      const c = map.get(name) ?? { name, firstChapter: d.chapterNumber, mainCount: 0, introduceCount: 0, total: 0, score: 0 }
      c.total++
      if (s.func === 'main') c.mainCount++
      if (s.func === 'introduce') c.introduceCount++
      map.set(name, c)
    }
  }
  for (const c of map.values()) c.score = c.mainCount * 3 + c.introduceCount * 2 + c.total
  return [...map.values()].sort((a, b) => b.score - a.score || a.firstChapter - b.firstChapter)
}
