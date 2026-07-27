/**
 * 字符级 diff
 *
 * 用途：段落级 diff 视图里，只改了一两个标点的段落会整段被标成"已改动"，
 * 作者得逐字去找改在哪。本模块把段落内部的差异定位到字符，供视图高亮。
 *
 * 采用 LCS 动态规划，逐字符（按码点，不按 UTF-16 单元）对齐，
 * 因此中文与 emoji 不会被拆坏。对超长文本用公共前后缀退化处理，避免卡界面。
 */

export type CharDiffKind = 'eq' | 'del' | 'ins'

export interface CharDiffSegment {
    kind: CharDiffKind
    text: string
}

/** DP 规模上限：超过则退化为公共前后缀切分（约 400k 单元，段落级足够用） */
const DP_CELL_LIMIT = 400_000

/** 合并相邻同类片段，避免逐字符碎片化 */
function coalesce(segments: CharDiffSegment[]): CharDiffSegment[] {
    const out: CharDiffSegment[] = []
    for (const seg of segments) {
        if (seg.text === '') continue
        const last = out[out.length - 1]
        if (last && last.kind === seg.kind) last.text += seg.text
        else out.push({ kind: seg.kind, text: seg.text })
    }
    return out
}

/**
 * 退化算法：剥掉公共前缀与公共后缀，中间整段视为差异。
 * 只在文本过长、DP 不划算时使用；结果仍然正确，只是定位不够细。
 */
function diffByAffix(a: string[], b: string[]): CharDiffSegment[] {
    let p = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    let s = 0
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++

    return coalesce([
        { kind: 'eq', text: a.slice(0, p).join('') },
        { kind: 'del', text: a.slice(p, a.length - s).join('') },
        { kind: 'ins', text: b.slice(p, b.length - s).join('') },
        { kind: 'eq', text: a.slice(a.length - s).join('') },
    ])
}

/**
 * 计算 a → b 的字符级差异。
 *
 * @param a 原文
 * @param b 改后文本
 * @returns 有序片段列表：eq 为两侧共有，del 只在 a 中，ins 只在 b 中
 */
export function diffChars(a: string, b: string): CharDiffSegment[] {
    if (a === b) return a === '' ? [] : [{ kind: 'eq', text: a }]

    const ca = Array.from(a)
    const cb = Array.from(b)

    // 先剥公共前后缀：标点替换场景下这一步就能把 DP 规模压到极小
    let p = 0
    while (p < ca.length && p < cb.length && ca[p] === cb[p]) p++
    let s = 0
    while (s < ca.length - p && s < cb.length - p && ca[ca.length - 1 - s] === cb[cb.length - 1 - s]) s++

    const prefix = ca.slice(0, p)
    const suffix = ca.slice(ca.length - s)
    const midA = ca.slice(p, ca.length - s)
    const midB = cb.slice(p, cb.length - s)

    if (midA.length === 0 || midB.length === 0) {
        return coalesce([
            { kind: 'eq', text: prefix.join('') },
            { kind: 'del', text: midA.join('') },
            { kind: 'ins', text: midB.join('') },
            { kind: 'eq', text: suffix.join('') },
        ])
    }

    if (midA.length * midB.length > DP_CELL_LIMIT) {
        return coalesce([
            { kind: 'eq', text: prefix.join('') },
            ...diffByAffix(midA, midB),
            { kind: 'eq', text: suffix.join('') },
        ])
    }

    // LCS 长度表
    const n = midA.length, m = midB.length
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = midA[i] === midB[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
    }

    // 回溯生成片段
    const mid: CharDiffSegment[] = []
    let i = 0, j = 0
    while (i < n && j < m) {
        if (midA[i] === midB[j]) {
            mid.push({ kind: 'eq', text: midA[i] }); i++; j++
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            mid.push({ kind: 'del', text: midA[i] }); i++
        } else {
            mid.push({ kind: 'ins', text: midB[j] }); j++
        }
    }
    while (i < n) { mid.push({ kind: 'del', text: midA[i] }); i++ }
    while (j < m) { mid.push({ kind: 'ins', text: midB[j] }); j++ }

    return coalesce([
        { kind: 'eq', text: prefix.join('') },
        ...mid,
        { kind: 'eq', text: suffix.join('') },
    ])
}
