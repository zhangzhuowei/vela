import { describe, it, expect } from 'vitest'
import { isTextGenerationModel, orderFallbackModels } from '../model-chain'

type Purpose = 'generation' | 'refinement' | 'summary' | 'embedding' | 'image'
const model = (id: string, baseUrl: string, purposes: Purpose[]) => ({ id, baseUrl, purposes })

describe('isTextGenerationModel', () => {
  it('生成 / 改写 / 摘要用途的模型可以做备用', () => {
    expect(isTextGenerationModel({ purposes: ['generation'] })).toBe(true)
    expect(isTextGenerationModel({ purposes: ['summary', 'embedding'] })).toBe(true)
  })

  it('只做 Embedding 或文生图的模型不能做备用', () => {
    expect(isTextGenerationModel({ purposes: ['embedding'] })).toBe(false)
    expect(isTextGenerationModel({ purposes: ['image'] })).toBe(false)
  })

  it('没填用途的老配置按生成模型对待', () => {
    expect(isTextGenerationModel({ purposes: [] })).toBe(true)
    expect(isTextGenerationModel({})).toBe(true)
  })
})

describe('orderFallbackModels', () => {
  const models = [
    model('main', 'https://a.example', ['generation']),
    model('same-provider', 'https://a.example', ['generation']),
    model('embed', 'https://b.example', ['embedding']),
    model('image', 'https://c.example', ['image']),
    model('other-provider', 'https://d.example', ['refinement']),
  ]

  it('排除主模型与 Embedding / 文生图模型', () => {
    const ids = orderFallbackModels(models, 'main').map((m) => m.id)
    expect(ids).not.toContain('main')
    expect(ids).not.toContain('embed')
    expect(ids).not.toContain('image')
  })

  it('不同服务商的备用模型排在前面', () => {
    expect(orderFallbackModels(models, 'main').map((m) => m.id)).toEqual(['other-provider', 'same-provider'])
  })
})
