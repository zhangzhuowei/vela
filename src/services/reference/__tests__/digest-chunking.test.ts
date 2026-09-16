import { describe, it, expect } from 'vitest'
import { splitDigestParts } from '../digest-chunking'
import { DIGEST_MAX_CHARS } from '../cost-estimate'

const join = (parts: string[]) => parts.join('')

describe('splitDigestParts', () => {
  it('returns the whole chapter when it fits', () => {
    expect(splitDigestParts('短章正文', 8000)).toEqual(['短章正文'])
  })

  it('returns one part when length equals the limit', () => {
    const text = '字'.repeat(DIGEST_MAX_CHARS)
    expect(splitDigestParts(text)).toEqual([text])
  })

  it('packs blank-line paragraphs without cutting through one', () => {
    const a = '甲段。'.repeat(40)
    const b = '乙段。'.repeat(40)
    const text = `${a}\n\n${b}`
    const parts = splitDigestParts(text, a.length + 2)
    expect(parts).toEqual([`${a}\n\n`, b])
    expect(join(parts)).toBe(text)
    expect(parts.every((p) => p.length <= a.length + 2)).toBe(true)
  })

  it('splits on single newlines when there are no blank lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `第${i}行${'内'.repeat(10)}`)
    const text = lines.join('\n')
    const max = 80
    const parts = splitDigestParts(text, max)
    expect(parts.length).toBeGreaterThan(1)
    expect(join(parts)).toBe(text)
    expect(parts.every((p) => p.length <= max)).toBe(true)
    expect(parts.some((p) => p.includes('\n'))).toBe(true)
  })

  it('splits an oversized line on sentence punctuation before hard-cutting', () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `这是第${i}句很长的话。`)
    const text = sentences.join('')
    const max = 40
    const parts = splitDigestParts(text, max)
    expect(join(parts)).toBe(text)
    expect(parts.every((p) => p.length <= max)).toBe(true)
    expect(parts.every((p) => p.endsWith('。') || p === parts.at(-1))).toBe(true)
  })

  it('hard-slices only when a unit has no boundary inside the limit', () => {
    const text = '啊'.repeat(25)
    const parts = splitDigestParts(text, 10)
    expect(parts).toEqual(['啊'.repeat(10), '啊'.repeat(10), '啊'.repeat(5)])
    expect(join(parts)).toBe(text)
  })

  it('keeps CRLF paragraph separators intact', () => {
    const a = '第一段'
    const b = '第二段'
    const text = `${a}\r\n\r\n${b}`
    const parts = splitDigestParts(text, a.length + 2)
    expect(join(parts)).toBe(text)
    expect(parts.every((p) => p.length <= a.length + 2)).toBe(true)
    expect(text.includes('\r\n\r\n')).toBe(true)
  })

  it('covers a 40k chapter with several <=8000 parts', () => {
    const para = (n: number) => `段落${n}。${'汉'.repeat(1200)}\n\n`
    const text = Array.from({ length: 40 }, (_, i) => para(i)).join('')
    const parts = splitDigestParts(text)
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.every((p) => p.length <= DIGEST_MAX_CHARS)).toBe(true)
    expect(join(parts)).toBe(text)
  })
})
