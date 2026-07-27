/**
 * 中文标点规范化
 *
 * 解决的问题：模型生成的中文正文里偶发混入半角标点（`,` `;` `:` `!` `?` `(` `)` `"`），
 * 与全角标点混排。而编辑器的字符串查找会做 Unicode NFKD 归一化，
 * 半角 `,`(U+002C) 与全角 `，`(U+FF0C) 在 NFKD 下等价，
 * 导致查找替换无法区分二者；半角双引号更是无法用替换处理——
 * 中文引号需要交替产出 `“` 与 `”`，普通替换只能得到同一个方向。
 *
 * 设计原则：只在中文语境下转换，宁可漏改也不错改；改不了的如实报告，不假装没问题。
 * - 仅当标点紧邻中日韩字符（含中文标点、全角字符）时才转换，
 *   因此 `1,000`、`foo(bar)`、`v1.2` 这类西文/数字用法不受影响。
 * - 代码块、行内代码、URL 一律跳过。
 * - 半角双引号按行配对：该行引号个数为偶数才转换，奇数则跳过并计入 `skipped`，
 *   避免方向判断错误后污染整行。
 * - 半角句点 `.` 与单引号 `'` 不做转换：句点会与小数点、省略号、文件名冲突，
 *   单引号与英文撇号（don't）无法区分。检测到的半角句点计入 `skipped` 供作者知情。
 */

/** 中日韩字符及中文标点、全角字符（用于判定"中文语境"） */
const CJK_CONTEXT = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/

/** 半角 → 全角映射（不含句点与引号，理由见文件头注释） */
const HALF_TO_FULL: Record<string, string> = {
  ',': '，',
  ';': '；',
  ':': '：',
  '!': '！',
  '?': '？',
}

export interface NormalizeResult {
  /** 规范化后的文本 */
  text: string
  /** 改动处数（0 表示无改动） */
  count: number
  /** 按类别拆分的改动数，用于向作者交代改了什么 */
  byKind: {
    /** , ; : ! ? */
    punctuation: number
    /** 成对小括号 */
    parens: number
    /** 成对双引号 */
    quotes: number
    /** 全角标点后多余的空格 */
    spaces: number
  }
  /** 刻意未处理但已检测到的项，用于如实反馈而非报告"无事发生" */
  skipped: {
    /** 中文语境下的半角句点 */
    periods: number
    /** 因该行引号个数为奇数而无法安全配对的半角双引号 */
    unpairedQuotes: number
  }
}

/** 标记出不参与替换的区间：围栏代码块、行内代码、URL */
function buildProtectedMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false)
  const protect = (from: number, to: number) => {
    for (let i = from; i < to && i < mask.length; i++) mask[i] = true
  }

  const patterns: RegExp[] = [
    /```[\s\S]*?```/g,                 // 围栏代码块
    /`[^`\n]*`/g,                      // 行内代码
    /(?:https?:\/\/|www\.)[^\s]+/gi,   // URL
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      protect(m.index, m.index + m[0].length)
      if (m[0].length === 0) re.lastIndex++ // 防御空匹配导致死循环
    }
  }
  return mask
}

/** 取 i 之前最近的非空格字符（跳过空格与制表符） */
function prevMeaningfulChar(chars: string[], i: number): string {
  for (let j = i - 1; j >= 0 && i - j <= 3; j--) {
    const c = chars[j]
    if (c === ' ' || c === '\t') continue
    return c
  }
  return ''
}

/** 取 i 之后最近的非空格字符（跳过空格与制表符） */
function nextMeaningfulChar(chars: string[], i: number): string {
  for (let j = i + 1; j < chars.length && j - i <= 3; j++) {
    const c = chars[j]
    if (c === ' ' || c === '\t') continue
    return c
  }
  return ''
}

/**
 * 把中文语境下的半角标点转成全角，并清理全角标点后多余的空格。
 *
 * 纯函数，不产生副作用；调用方应当把结果拿去做对比预览，由作者确认后再落盘。
 *
 * @param input 原文
 * @returns 规范化后的文本、改动统计与刻意跳过项
 */
export function normalizeChinesePunctuation(input: string): NormalizeResult {
  const byKind = { punctuation: 0, parens: 0, quotes: 0, spaces: 0 }
  const skipped = { periods: 0, unpairedQuotes: 0 }
  if (!input) return { text: input, count: 0, byKind, skipped }

  const chars = Array.from(input)
  // 掩码按 UTF-16 下标构建，字符数组按码点切分；这里按码点重建，保证下标对齐
  const rawMask = buildProtectedMask(input)
  const mask = new Array<boolean>(chars.length).fill(false)
  {
    let utf16 = 0
    for (let i = 0; i < chars.length; i++) {
      mask[i] = rawMask[utf16] ?? false
      utf16 += chars[i].length
    }
  }

  // ── 第 1 步：成对处理小括号 ──────────────────────────────
  // 只有当括号内出现中文时才整对替换，避免把 markdown 链接、英文括注改坏。
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '(' || mask[i]) continue
    let close = -1
    for (let j = i + 1; j < chars.length; j++) {
      if (chars[j] === '\n') break            // 不跨行配对
      if (chars[j] === '(') break             // 出现嵌套则放弃，保持原样
      if (chars[j] === ')' && !mask[j]) { close = j; break }
    }
    if (close === -1) continue
    const inner = chars.slice(i + 1, close).join('')
    if (!CJK_CONTEXT.test(inner)) continue
    chars[i] = '（'
    chars[close] = '）'
    byKind.parens += 2
  }

  // ── 第 2 步：逐字处理 , ; : ! ? ──────────────────────────
  for (let i = 0; i < chars.length; i++) {
    if (mask[i]) continue
    const full = HALF_TO_FULL[chars[i]]
    if (!full) continue
    // 前后任一侧处于中文语境即转换：覆盖"他没事,继续"与"他没事, 继续"两种写法
    const prev = prevMeaningfulChar(chars, i)
    const next = nextMeaningfulChar(chars, i)
    if (!CJK_CONTEXT.test(prev) && !CJK_CONTEXT.test(next)) continue
    chars[i] = full
    byKind.punctuation++
  }

  // ── 第 3 步：按行配对处理半角双引号 ──────────────────────
  // 中文引号需要交替产出 “ 与 ”，方向依赖配对，因此逐行处理：
  // 该行引号个数为偶数才转换；奇数说明引号跨行或缺失，计入 skipped 交给作者判断。
  {
    let lineStart = 0
    const flushLine = (end: number) => {
      const quoteIdx: number[] = []
      let hasCjk = false
      for (let i = lineStart; i < end; i++) {
        if (mask[i]) continue
        if (chars[i] === '"') quoteIdx.push(i)
        else if (!hasCjk && CJK_CONTEXT.test(chars[i])) hasCjk = true
      }
      if (quoteIdx.length === 0 || !hasCjk) return
      if (quoteIdx.length % 2 !== 0) {
        skipped.unpairedQuotes += quoteIdx.length
        return
      }
      quoteIdx.forEach((idx, order) => {
        chars[idx] = order % 2 === 0 ? '“' : '”'
        byKind.quotes++
      })
    }
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === '\n') {
        flushLine(i)
        lineStart = i + 1
      }
    }
    flushLine(chars.length)
  }

  // ── 第 4 步：统计（不处理）中文语境下的半角句点 ──────────
  for (let i = 0; i < chars.length; i++) {
    if (mask[i] || chars[i] !== '.') continue
    const prev = chars[i - 1] ?? ''
    const next = chars[i + 1] ?? ''
    // 连续句点视为省略号，不计入
    if (prev === '.' || next === '.') continue
    if (CJK_CONTEXT.test(prev) && (next === '' || next === '\n' || CJK_CONTEXT.test(next))) {
      skipped.periods++
    }
  }

  let text = chars.join('')

  // ── 第 5 步：清理全角标点后多余的空格 ────────────────────
  // 模型写 "他没事, 继续" 时空格会残留在全角逗号之后，中文排版里这是多余的。
  const spaceAfterFull = /([，。；：！？、）】」』”])[ \t]+(?=[^\s])/g
  text = text.replace(spaceAfterFull, (_m, p1: string) => {
    byKind.spaces++
    return p1
  })

  const count = byKind.punctuation + byKind.parens + byKind.quotes + byKind.spaces
  return { text, count, byKind, skipped }
}

/** 把改动统计拼成一句人类可读的摘要，供 UI 展示 */
export function describeNormalizeResult(r: NormalizeResult): string {
  const parts: string[] = []
  if (r.byKind.punctuation) parts.push(`标点 ${r.byKind.punctuation}`)
  if (r.byKind.quotes) parts.push(`引号 ${r.byKind.quotes}`)
  if (r.byKind.parens) parts.push(`括号 ${r.byKind.parens}`)
  if (r.byKind.spaces) parts.push(`多余空格 ${r.byKind.spaces}`)
  return parts.join(' · ')
}
