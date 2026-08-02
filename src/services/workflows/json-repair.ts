/**
 * 共享的容错 JSON 解析工具。
 *
 * LLM 返回的 JSON 常见三类问题：
 *  1) 字符串值里出现未转义的裸控制字符（真实换行/制表符）→ JSON.parse 抛
 *     "Bad control character in string literal"。
 *  2) 字符串值里出现未转义的半角双引号（多见于中文对白）→ 内层引号提前闭合字符串，
 *     抛 "Expected ',' or '}' after property value"。
 *  3) 输出撞上模型单次上限（max_tokens）被截断，数组/对象未闭合 → 整体解析失败。
 *
 * 本模块把修复原语与解析入口收敛到一处，供各工作流命令复用：
 *  - parseJSONWithRepair：应用 (1)(2) 的修复链，任一成功即返回，全部失败抛首个错误；不处理截断。
 *  - parseJSONLenient：先走修复链，仍失败（多为截断）则在“已转义控制字符”的文本上
 *    抢救所有已完整闭合的顶层数组元素。
 */

/**
 * 转义 JSON 字符串字面量内部的裸控制字符（未转义的换行/制表符等）。
 *
 * 只处理字符串内部的裸控制字符，字符串外的空白（token 间的换行/缩进）原样保留，
 * 因此对本就合法的 JSON 没有任何影响。
 */
export function escapeControlCharsInStrings(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        out += ch
        inString = false
        continue
      }
      const code = input.charCodeAt(i)
      if (code < 0x20) {
        switch (ch) {
          case '\n': out += '\\n'; break
          case '\r': out += '\\r'; break
          case '\t': out += '\\t'; break
          case '\b': out += '\\b'; break
          case '\f': out += '\\f'; break
          default: out += '\\u' + code.toString(16).padStart(4, '0')
        }
        continue
      }
      out += ch
    } else {
      if (ch === '"') inString = true
      out += ch
    }
  }
  return out
}

/**
 * 转义字符串值内部未转义的半角双引号。
 *
 * LLM 写中文对白时常直接用半角引号，如
 *   "mentalState": "他听见"梦魇之月"这个名字"
 * 内层引号会提前闭合字符串，JSON.parse 抛
 * "Expected ',' or '}' after property value"。
 *
 * 判定规则：处于字符串中遇到 " 时向后跳过空白，若紧接的是 , } ] : 或输入结束，
 * 才视为真正的闭合引号；否则视为内容的一部分并转义为 \"。
 */
export function escapeStrayQuotesInStrings(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j])) j++
      const next = j < input.length ? input[j] : ''
      if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
        out += ch
        inString = false
      } else {
        // 字符串内部的游离引号：转义，不闭合字符串
        out += '\\"'
      }
      continue
    }
    out += ch
  }
  return out
}

/**
 * 构建修复候选链：原样 → 转义裸控制字符 → 转义游离引号 → 两者叠加。
 * 顺序保证“先尝试代价最小的修复”，避免对本就合法的 JSON 做不必要的改写。
 */
export function buildRepairCandidates(cleanText: string): string[] {
  return [
    cleanText,
    escapeControlCharsInStrings(cleanText),
    escapeStrayQuotesInStrings(cleanText),
    escapeStrayQuotesInStrings(escapeControlCharsInStrings(cleanText)),
  ]
}

/**
 * 依次尝试修复候选链，任一成功即返回；全部失败则抛出首个（最原始的）解析错误，
 * 保留可读的诊断信息。不处理截断——截断场景请用 parseJSONLenient。
 */
export function parseJSONWithRepair<T>(cleanText: string): T {
  let firstError: unknown = null
  for (const candidate of buildRepairCandidates(cleanText)) {
    try {
      return JSON.parse(candidate) as T
    } catch (err) {
      if (firstError === null) firstError = err
    }
  }
  throw firstError
}

/**
 * 容错解析可能被截断的 JSON 数组。
 *
 * 1) 先在整段文本上走修复链（治裸控制字符 / 游离引号）；
 * 2) 仍失败（多为 max_tokens 截断导致数组未闭合）→ 在“已转义控制字符”的文本上
 *    扫描并保留所有已完整闭合的顶层元素，重新拼成合法数组，
 *    并通过 truncated 标记告知调用方输出不完整。
 *
 * 在已转义控制字符的文本上做抢救，可避免括号扫描与最终切片再解析时
 * 再次被裸控制字符打断（这是此前提取批次整批失败的根因）。
 */
export function parseJSONLenient(raw: string): { data: unknown; truncated: boolean } {
  // 1) 整段修复链：非截断类问题（含裸控制字符/游离引号）在此即可解决
  for (const candidate of buildRepairCandidates(raw)) {
    try {
      return { data: JSON.parse(candidate), truncated: false }
    } catch {
      // 试下一个候选
    }
  }

  // 2) 截断抢救：在已转义控制字符的文本上进行
  const escaped = escapeControlCharsInStrings(raw)
  const arrayStart = escaped.indexOf('[')
  if (arrayStart === -1) throw new Error('AI 返回内容中未找到 JSON 数组')

  let depth = 0
  let inString = false
  let escapedChar = false
  let lastCompleteEnd = -1

  for (let i = arrayStart + 1; i < escaped.length; i++) {
    const ch = escaped[i]
    if (escapedChar) { escapedChar = false; continue }
    if (ch === '\\') { escapedChar = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue

    if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) {
        // 顶层的一个元素刚刚完整闭合
        lastCompleteEnd = i
      } else if (depth < 0) {
        // 数组本体已闭合，lastCompleteEnd 已指向最后一个完整元素
        break
      }
    }
  }

  if (lastCompleteEnd === -1) {
    throw new Error('AI 返回的 JSON 被截断，且没有任何完整的角色对象可供抢救。请减少单批提取的角色数量后重试')
  }

  const repaired = escaped.slice(arrayStart, lastCompleteEnd + 1) + ']'
  return { data: parseJSONWithRepair(repaired), truncated: true }
}
