/**
 * 三栏合并视图 — 基于相似度 DP 对齐的段落级 diff
 *
 * 核心算法改进：
 * - 使用字符重叠率计算段落相似度
 * - DP 动态规划支持 1:1、1:2、1:3、2:1、3:1 段落对齐
 * - 正确处理段落拆分（1段→2段）和合并（2段→1段）
 *
 * 布局：左栏原稿（只读）| 中栏合并结果（可编辑）| 右栏修稿（只读）
 */
import React, { useState, useCallback, useRef, useMemo, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { diffChars } from '../../lib/char-diff'
import './three-way-merge.css'

// ===== 类型定义 =====
interface Hunk {
  index: number
  originalLines: string[]
  modifiedLines: string[]
}

interface DiffSegment {
  type: 'same' | 'hunk'
  lines?: string[]
  hunk?: Hunk
}

interface ThreeWayMergeProps {
  originalContent: string
  modifiedContent: string
  onComplete: (mergedText: string) => void
  onCancel?: () => void
  /**
   * 文案覆盖。用于非「修稿合并」场景复用本视图（如标点规范化），
   * 避免出现「修稿」「完成合并」这类与实际操作不符的字眼。缺省走 i18n 默认值。
   */
  labels?: {
    /** 右栏标题 */
    modified?: string
    /** 确认按钮 */
    complete?: string
  }
  /**
   * 初始即采用全部变更。
   * 修稿合并默认逐条确认（不采用），而机械性批量改写（如标点规范化）
   * 的预期是全部生效、个别排除，故由调用方指定初始态。
   */
  defaultApplyAll?: boolean
  /**
   * 在改动段落内部标出字符级差异。
   * 标点这类单字符改动若只做整段着色，作者得逐字去找改在哪；
   * 大段重写则相反，满屏字符高亮反而更乱，故由调用方按场景开启。
   */
  inlineCharDiff?: boolean
}

// ===== 文本工具 =====

/** 去除 YAML frontmatter */
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? text.slice(m[0].length) : text
}

/**
 * 提取段落列表（非空文本块，空行是分隔符）
 * 返回格式：每个元素是一个段落的完整文本（可能包含多行）
 */
function extractParagraphs(text: string): string[] {
  const lines = text.split('\n')
  const paras: string[] = []
  let buf: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (buf.length > 0) { paras.push(buf.join('\n')); buf = [] }
    } else {
      buf.push(line)
    }
  }
  if (buf.length > 0) paras.push(buf.join('\n'))
  return paras
}

/** 字符频率 map */
type CharFreq = Map<string, number>

function buildCharFreq(text: string): CharFreq {
  const freq: CharFreq = new Map()
  for (const c of text) freq.set(c, (freq.get(c) || 0) + 1)
  return freq
}

/** 合并多个频率 map */
function mergeFreqs(...maps: CharFreq[]): CharFreq {
  const merged: CharFreq = new Map()
  for (const m of maps) for (const [c, n] of m) merged.set(c, (merged.get(c) || 0) + n)
  return merged
}

/** 从预计算的频率 map 计算相似度（避免重复创建 Map） */
function simFromFreqs(fa: CharFreq, lenA: number, fb: CharFreq, lenB: number): number {
  if (lenA === 0 && lenB === 0) return 1
  if (lenA === 0 || lenB === 0) return 0
  // 长度比 >5 直接判定不相似（快速拒绝）
  if (lenA > lenB * 5 || lenB > lenA * 5) return 0
  let common = 0
  // 遍历较小的 map 提高效率
  const [smaller, larger] = fa.size <= fb.size ? [fa, fb] : [fb, fa]
  for (const [c, n] of smaller) common += Math.min(n, larger.get(c) || 0)
  return (2 * common) / (lenA + lenB)
}

// ===== DP 段落对齐算法 =====

/** 对齐操作类型 */
const enum AlignOp {
  MATCH, DELETE, INSERT, SPLIT_1_2, SPLIT_1_3, MERGE_2_1, MERGE_3_1,
}

interface AlignPair {
  origIdx: number[]
  modIdx: number[]
}

/**
 * 基于相似度的 DP 段落对齐（性能优化版）
 * 预计算所有频率 map，避免 DP 循环中重复创建
 */
function alignParagraphs(origParas: string[], modParas: string[]): AlignPair[] {
  const n = origParas.length, m = modParas.length
  const SIM_THRESH = 0.15, GAP = -0.05

  // ===== 预计算频率 map =====
  const oFreqs = origParas.map(buildCharFreq)
  const mFreqs = modParas.map(buildCharFreq)
  const oLens = origParas.map(p => p.length)
  const mLens = modParas.map(p => p.length)

  // 预计算相邻 2/3 段落的合并频率（用于 split/merge）
  const mPairFreqs: CharFreq[] = new Array(m)
  const mPairLens: number[] = new Array(m)
  for (let j = 1; j < m; j++) {
    mPairFreqs[j] = mergeFreqs(mFreqs[j - 1], mFreqs[j])
    mPairLens[j] = mLens[j - 1] + mLens[j]
  }
  const mTriFreqs: CharFreq[] = new Array(m)
  const mTriLens: number[] = new Array(m)
  for (let j = 2; j < m; j++) {
    mTriFreqs[j] = mergeFreqs(mFreqs[j - 2], mFreqs[j - 1], mFreqs[j])
    mTriLens[j] = mLens[j - 2] + mLens[j - 1] + mLens[j]
  }
  const oPairFreqs: CharFreq[] = new Array(n)
  const oPairLens: number[] = new Array(n)
  for (let i = 1; i < n; i++) {
    oPairFreqs[i] = mergeFreqs(oFreqs[i - 1], oFreqs[i])
    oPairLens[i] = oLens[i - 1] + oLens[i]
  }
  const oTriFreqs: CharFreq[] = new Array(n)
  const oTriLens: number[] = new Array(n)
  for (let i = 2; i < n; i++) {
    oTriFreqs[i] = mergeFreqs(oFreqs[i - 2], oFreqs[i - 1], oFreqs[i])
    oTriLens[i] = oLens[i - 2] + oLens[i - 1] + oLens[i]
  }

  // ===== DP =====
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1e9))
  const op: AlignOp[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(AlignOp.MATCH))
  dp[0][0] = 0
  for (let i = 1; i <= n; i++) { dp[i][0] = i * GAP; op[i][0] = AlignOp.DELETE }
  for (let j = 1; j <= m; j++) { dp[0][j] = j * GAP; op[0][j] = AlignOp.INSERT }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = -1e9, bestOp = AlignOp.MATCH

      // 1:1
      const s11 = simFromFreqs(oFreqs[i - 1], oLens[i - 1], mFreqs[j - 1], mLens[j - 1])
      const v11 = dp[i - 1][j - 1] + (s11 >= SIM_THRESH ? s11 : s11 - 0.5)
      if (v11 > best) { best = v11; bestOp = AlignOp.MATCH }

      // 删除 / 插入
      if (dp[i - 1][j] + GAP > best) { best = dp[i - 1][j] + GAP; bestOp = AlignOp.DELETE }
      if (dp[i][j - 1] + GAP > best) { best = dp[i][j - 1] + GAP; bestOp = AlignOp.INSERT }

      // 1:2 拆分
      if (j >= 2) {
        const s = simFromFreqs(oFreqs[i - 1], oLens[i - 1], mPairFreqs[j - 1], mPairLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 1][j - 2] + s * 0.95; if (v > best) { best = v; bestOp = AlignOp.SPLIT_1_2 } }
      }
      // 1:3 拆分
      if (j >= 3) {
        const s = simFromFreqs(oFreqs[i - 1], oLens[i - 1], mTriFreqs[j - 1], mTriLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 1][j - 3] + s * 0.9; if (v > best) { best = v; bestOp = AlignOp.SPLIT_1_3 } }
      }
      // 2:1 合并
      if (i >= 2) {
        const s = simFromFreqs(oPairFreqs[i - 1], oPairLens[i - 1], mFreqs[j - 1], mLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 2][j - 1] + s * 0.95; if (v > best) { best = v; bestOp = AlignOp.MERGE_2_1 } }
      }
      // 3:1 合并
      if (i >= 3) {
        const s = simFromFreqs(oTriFreqs[i - 1], oTriLens[i - 1], mFreqs[j - 1], mLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 3][j - 1] + s * 0.9; if (v > best) { best = v; bestOp = AlignOp.MERGE_3_1 } }
      }

      dp[i][j] = best; op[i][j] = bestOp
    }
  }

  // 回溯构建对齐结果
  const pairs: AlignPair[] = []
  let ci = n, cj = m
  while (ci > 0 || cj > 0) {
    if (ci === 0) { pairs.unshift({ origIdx: [], modIdx: [--cj] }); continue }
    if (cj === 0) { pairs.unshift({ origIdx: [--ci], modIdx: [] }); continue }
    switch (op[ci][cj]) {
      case AlignOp.MATCH:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [cj - 1] }); ci--; cj--; break
      case AlignOp.DELETE:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [] }); ci--; break
      case AlignOp.INSERT:
        pairs.unshift({ origIdx: [], modIdx: [cj - 1] }); cj--; break
      case AlignOp.SPLIT_1_2:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [cj - 2, cj - 1] }); ci--; cj -= 2; break
      case AlignOp.SPLIT_1_3:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [cj - 3, cj - 2, cj - 1] }); ci--; cj -= 3; break
      case AlignOp.MERGE_2_1:
        pairs.unshift({ origIdx: [ci - 2, ci - 1], modIdx: [cj - 1] }); ci -= 2; cj--; break
      case AlignOp.MERGE_3_1:
        pairs.unshift({ origIdx: [ci - 3, ci - 2, ci - 1], modIdx: [cj - 1] }); ci -= 3; cj--; break
    }
  }
  return pairs
}

// ===== 从对齐结果生成 DiffSegment =====

function buildSegments(origParas: string[], modParas: string[], pairs: AlignPair[]): DiffSegment[] {
  const segments: DiffSegment[] = []
  let hunkIdx = 0

  /** 段落文本 → 行数组 */
  const paraToLines = (para: string) => para.split('\n')

  /** 多个段落 → 行数组（段落间插入空行） */
  const parasToLines = (paras: string[], indices: number[]) => {
    const lines: string[] = []
    indices.forEach((idx, i) => {
      if (i > 0) lines.push('') // 段落间空行
      lines.push(...paraToLines(paras[idx]))
    })
    return lines
  }

  for (let p = 0; p < pairs.length; p++) {
    const pair = pairs[p]
    const origLines = pair.origIdx.length > 0 ? parasToLines(origParas, pair.origIdx) : []
    const modLines = pair.modIdx.length > 0 ? parasToLines(modParas, pair.modIdx) : []

    // 判断是否完全相同
    const isSame = origLines.length > 0 && modLines.length > 0 &&
      origLines.length === modLines.length &&
      origLines.every((l, i) => l === modLines[i])

    if (isSame) {
      segments.push({ type: 'same', lines: origLines })
    } else {
      segments.push({
        type: 'hunk',
        hunk: { index: hunkIdx++, originalLines: origLines, modifiedLines: modLines },
      })
    }

    // 段落之间插入空行同步锚点（最后一组不加）
    if (p < pairs.length - 1) {
      segments.push({ type: 'same', lines: [''] })
    }
  }
  return segments
}

/** 入口：计算 diff segments */
function computeSegments(original: string, modified: string): DiffSegment[] {
  const cleanOrig = stripFrontmatter(original)
  const cleanMod = stripFrontmatter(modified)
  const origParas = extractParagraphs(cleanOrig)
  const modParas = extractParagraphs(cleanMod)
  const pairs = alignParagraphs(origParas, modParas)
  return buildSegments(origParas, modParas, pairs)
}

// ===== 渲染辅助 =====

/**
 * 渲染单行的字符级差异。
 * side 决定保留哪一侧：left 保留原文（eq + del），right 保留改后（eq + ins）。
 */
function InlineDiffLine({ original, modified, side }: {
  original: string; modified: string; side: 'left' | 'right'
}) {
  const segments = useMemo(() => diffChars(original, modified), [original, modified])
  const keepKind = side === 'left' ? 'del' : 'ins'
  const markCls = side === 'left' ? 'twm-chg-del' : 'twm-chg-ins'

  const visible = segments.filter(s => s.kind === 'eq' || s.kind === keepKind)
  if (visible.length === 0) return <>{'\u00A0'}</>

  return (
    <>
      {visible.map((seg, i) => seg.kind === 'eq'
        ? <span key={i}>{seg.text}</span>
        // 空格被改动时本身不可见，用类名兜住背景色使其可被看见
        : <span key={i} className={markCls}>{seg.text}</span>
      )}
    </>
  )
}

function HunkLines({ lines, padCount, cls, emptyLabel, counterpart, side }: {
  lines: string[]; padCount: number; cls: string; emptyLabel: string
  /** 对侧文本；提供且行数一致时启用字符级高亮 */
  counterpart?: string[]
  side?: 'left' | 'right'
}) {
  // 行数不一致（段落拆分/合并）时无法按行配对，退回整行着色
  const pairable = !!counterpart && !!side && counterpart.length === lines.length

  return (
    <>
      {lines.length > 0
        ? lines.map((l, i) => (
          <div key={i} className={cls}>
            {pairable
              ? <InlineDiffLine
                original={side === 'left' ? l : counterpart![i]}
                modified={side === 'left' ? counterpart![i] : l}
                side={side!}
              />
              : (l || '\u00A0')}
          </div>
        ))
        : <div className="twm-line-placeholder">{emptyLabel}</div>}
      {Array.from({ length: padCount }).map((_, i) => (
        <div key={`p${i}`} className="twm-line-padding">{'\u00A0'}</div>
      ))}
    </>
  )
}

/** contentEditable 子组件 — 仅在挂载时设置内容 */
function EditableCell({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = text || '\u00A0'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div ref={ref} className="twm-editable" contentEditable
      suppressContentEditableWarning
      onInput={e => onChange((e.target as HTMLDivElement).innerText)} />
  )
}

// ===== 主组件 =====

export default function ThreeWayMerge({
  originalContent, modifiedContent, onComplete, onCancel, labels,
  defaultApplyAll = false, inlineCharDiff = false,
}: ThreeWayMergeProps) {
  const { t } = useTranslation('editors')
  const segments = useMemo(() => computeSegments(originalContent, modifiedContent),
    [originalContent, modifiedContent])
  const hunks = useMemo(() => segments.filter(s => s.type === 'hunk').map(s => s.hunk!), [segments])

  const [applied, setApplied] = useState<Record<number, boolean>>(() => {
    if (!defaultApplyAll) return {}
    const init: Record<number, boolean> = {}
    segments.forEach(s => { if (s.hunk) init[s.hunk.index] = true })
    return init
  })

  // 每个 segment 的编辑文本
  const [segTexts, setSegTexts] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {}
    segments.forEach((s, i) => {
      if (s.type === 'same') init[i] = (s.lines || []).join('\n')
      else if (s.hunk) init[i] = (defaultApplyAll ? s.hunk.modifiedLines : s.hunk.originalLines).join('\n')
    })
    return init
  })

  // hunk index → segment index 映射
  const hunkSegIdx = useMemo(() => {
    const m: Record<number, number> = {}
    segments.forEach((s, i) => { if (s.hunk) m[s.hunk.index] = i })
    return m
  }, [segments])

  const buildMergedText = useCallback(() => {
    return segments.map((_, i) => segTexts[i] ?? '').join('\n')
  }, [segments, segTexts])

  const toggleHunk = useCallback((idx: number) => {
    setApplied(prev => {
      const next = { ...prev, [idx]: !prev[idx] }
      const hunk = hunks.find(h => h.index === idx)
      const si = hunkSegIdx[idx]
      if (hunk && si !== undefined) {
        const text = next[idx] ? hunk.modifiedLines.join('\n') : hunk.originalLines.join('\n')
        setSegTexts(p => ({ ...p, [si]: text }))
      }
      return next
    })
  }, [hunks, hunkSegIdx])

  const applyAll = useCallback(() => {
    const next: Record<number, boolean> = {}
    const texts: Record<number, string> = {}
    hunks.forEach(h => { next[h.index] = true; texts[hunkSegIdx[h.index]] = h.modifiedLines.join('\n') })
    setApplied(next); setSegTexts(p => ({ ...p, ...texts }))
  }, [hunks, hunkSegIdx])

  const revertAll = useCallback(() => {
    const texts: Record<number, string> = {}
    hunks.forEach(h => { texts[hunkSegIdx[h.index]] = h.originalLines.join('\n') })
    setApplied({}); setSegTexts(p => ({ ...p, ...texts }))
  }, [hunks, hunkSegIdx])

  const processedCount = Object.values(applied).filter(Boolean).length

  const getPad = (oLen: number, mLen: number) => {
    const lV = oLen > 0 ? oLen : 1, rV = mLen > 0 ? mLen : 1
    return { leftPad: Math.max(0, rV - lV), rightPad: Math.max(0, lV - rV) }
  }

  return (
    <div className="three-way-merge">
      <div className="twm-toolbar">
        <Button variant="ghost" size="sm" onClick={revertAll}>{t('threeWayMerge.revertAll')}</Button>
        <Button variant="ghost" size="sm" onClick={applyAll}>{t('threeWayMerge.applyAll')}</Button>
        <span className="twm-toolbar-progress">{t('threeWayMerge.progress', { applied: processedCount, total: hunks.length })}</span>
        {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>{t('threeWayMerge.cancel')}</Button>}
        <Button variant="success" size="sm" onClick={() => onComplete(buildMergedText())}>{labels?.complete ?? t('threeWayMerge.completeMerge')}</Button>
      </div>

      {/* 固定表头 */}
      <div className="twm-headers">
        <div className="twm-header">{t('threeWayMerge.original')} <span className="twm-tag readonly">{t('threeWayMerge.readonly')}</span></div>
        <div className="twm-header">{t('threeWayMerge.mergeResult')} <span className="twm-tag editable">{t('threeWayMerge.editable')}</span></div>
        <div className="twm-header">{labels?.modified ?? t('threeWayMerge.revised')} <span className="twm-tag readonly">{t('threeWayMerge.readonly')}</span></div>
      </div>

      {/* 单滚动容器 + CSS Grid 自动行高对齐 */}
      <div className="twm-scroll">
        <div className="twm-grid">
          {segments.map((seg, idx) => {
            if (seg.type === 'same') {
              // same 行：三栏静态文本，中栏可编辑
              return (
                <React.Fragment key={idx}>
                  <div className="twm-cell twm-cell-left">
                    {seg.lines?.map((l, i) => <div key={i} className="twm-line-same">{l || '\u00A0'}</div>)}
                  </div>
                  <div className="twm-cell twm-cell-center">
                    <EditableCell key={`s${idx}`} text={segTexts[idx] ?? ''}
                      onChange={t => setSegTexts(p => ({ ...p, [idx]: t }))} />
                  </div>
                  <div className="twm-cell twm-cell-right">
                    {seg.lines?.map((l, i) => <div key={i} className="twm-line-same">{l || '\u00A0'}</div>)}
                  </div>
                </React.Fragment>
              )
            }

            // hunk 行
            const hunk = seg.hunk!
            const isApplied = applied[hunk.index]
            const { leftPad, rightPad } = getPad(hunk.originalLines.length, hunk.modifiedLines.length)

            return (
              <React.Fragment key={idx}>
                {/* 左栏 */}
                <div className={`twm-cell twm-cell-left ${isApplied ? 'processed' : ''}`}>
                  <HunkLines lines={hunk.originalLines} padCount={leftPad}
                    cls={inlineCharDiff ? 'twm-line-removed subtle' : 'twm-line-removed'}
                    counterpart={inlineCharDiff ? hunk.modifiedLines : undefined} side="left"
                    emptyLabel={t('threeWayMerge.newLines', { count: hunk.modifiedLines.length })} />
                </div>

                {/* 中栏 */}
                <div className={`twm-cell twm-cell-center ${isApplied ? 'adopted' : 'pending'}`}>
                  <EditableCell key={`h${idx}-${isApplied ? 1 : 0}`} text={segTexts[idx] ?? ''}
                    onChange={t => setSegTexts(p => ({ ...p, [idx]: t }))} />
                </div>

                {/* 右栏（含采用按钮） */}
                <div className={`twm-cell twm-cell-right ${isApplied ? 'processed' : ''}`}>
                  <div className="twm-hunk-row">
                    <button className={`twm-adopt ${isApplied ? 'adopted' : ''}`}
                      onClick={() => toggleHunk(hunk.index)}
                      title={isApplied ? t('threeWayMerge.revertTooltip') : t('threeWayMerge.adoptTooltip')}>
                      {isApplied ? '✓' : '«'}
                    </button>
                    <div className="twm-hunk-text">
                      <HunkLines lines={hunk.modifiedLines} padCount={rightPad}
                        cls={inlineCharDiff ? 'twm-line-added subtle' : 'twm-line-added'}
                        counterpart={inlineCharDiff ? hunk.originalLines : undefined} side="right"
                        emptyLabel={t('threeWayMerge.deletedLines', { count: hunk.originalLines.length })} />
                    </div>
                  </div>
                </div>
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

