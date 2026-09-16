import { describe, expect, it } from 'vitest'
import { chunkText } from '../embedding'

describe('chunkText', () => {
  it('does not start the next chunk with a mid-line overlap tail', () => {
    const a = '【基础动作·插入抽动类】搅动：舌头插入后大范围旋转搅动，包括左右搅、上下搅、画圈搅等，扩大刺激范围\n刺激前列腺：用舌头专门刺激肛门内的前列腺，需要一定技巧和舌头长度'
    const b = '【基础动作·按压震颤类】按压：舌头按压对方身体，包括舌尖点按、舌面按压、重压、轻压'
    const maxChars = a.length + 10
    const chunks = chunkText(`${a}\n\n${b}`, maxChars, 50)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[1].startsWith('【')).toBe(true)
    expect(chunks[1]).not.toMatch(/^搅、/)
    expect(chunks[1]).toContain('按压震颤类')
  })

  it('does not prepend a raw character tail when a long paragraph is sentence-split', () => {
    const para = `${'前文。'.repeat(40)}结尾句要从下一块完整开始。`
    const chunks = chunkText(para, 80, 20)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c).not.toMatch(/^[。！？.!?]/)
    }
  })
})
