import { DIGEST_MAX_CHARS } from './cost-estimate'

type Boundary = 'blank' | 'newline' | 'sentence' | 'hard'

const BLANK = /(?:\r?\n)(?:[ \t]*\r?\n)+/g
const NEWLINE = /\r?\n/g
const SENTENCE = /[。！？!?…]+[」』"']?/g

function nextBoundary(level: Boundary): Boundary {
  if (level === 'blank') return 'newline'
  if (level === 'newline') return 'sentence'
  return 'hard'
}

function delim(level: Exclude<Boundary, 'hard'>): RegExp {
  if (level === 'blank') return BLANK
  if (level === 'newline') return NEWLINE
  return SENTENCE
}

function splitKeepSep(text: string, re: RegExp): string[] {
  const r = new RegExp(re.source, 'g')
  const parts: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = r.exec(text))) {
    const end = m.index + m[0].length
    if (end === last) {
      r.lastIndex += 1
      continue
    }
    parts.push(text.slice(last, end))
    last = end
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length > 0 ? parts : [text]
}

function hardSlice(text: string, maxChars: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += maxChars) parts.push(text.slice(i, i + maxChars))
  return parts.length > 0 ? parts : [text]
}

function pack(text: string, maxChars: number, level: Boundary): string[] {
  if (text.length <= maxChars) return [text]
  if (level === 'hard') return hardSlice(text, maxChars)

  const units = splitKeepSep(text, delim(level))
  if (units.length <= 1) return pack(text, maxChars, nextBoundary(level))

  const out: string[] = []
  let buf = ''
  for (const unit of units) {
    const pieces = unit.length <= maxChars ? [unit] : pack(unit, maxChars, nextBoundary(level))
    for (const piece of pieces) {
      if (!buf) {
        buf = piece
        continue
      }
      if (buf.length + piece.length <= maxChars) buf += piece
      else {
        out.push(buf)
        buf = piece
      }
    }
  }
  if (buf) out.push(buf)
  return out
}

/** 按空白段 → 换行 → 句读打包；无边界时才硬切。拼接结果等于原文。 */
export function splitDigestParts(content: string, maxChars = DIGEST_MAX_CHARS): string[] {
  const limit = Math.max(1, maxChars)
  if (content.length <= limit) return [content]
  return pack(content, limit, 'blank')
}
