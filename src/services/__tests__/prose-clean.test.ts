import { describe, expect, it } from 'vitest'
import { stripEditorialMarkers, stripThinkingTags } from '../prose-clean'

describe('stripEditorialMarkers', () => {
  it('removes fullwidth and halfwidth source markers', () => {
    expect(stripEditorialMarkers('她不敢想象如果（据前文线索）指挥官知道这一切。')).toBe(
      '她不敢想象如果指挥官知道这一切。',
    )
    expect(stripEditorialMarkers('她不敢想象如果(据前文线索)指挥官知道这一切。')).toBe(
      '她不敢想象如果指挥官知道这一切。',
    )
  })

  it('leaves ordinary parentheticals alone', () => {
    expect(stripEditorialMarkers('她低声说（几乎听不见）。')).toBe('她低声说（几乎听不见）。')
  })
})

describe('stripThinkingTags', () => {
  it('strips think tags and editorial markers together', () => {
    expect(stripThinkingTags('<think>推理</think>如果（据前文线索）他知道。')).toBe('如果他知道。')
  })
})
