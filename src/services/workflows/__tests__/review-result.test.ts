import { describe, it, expect } from 'vitest'
import { blockingCount, normalizeReviewResult, normalizeSeverity } from '../review-result'

describe('normalizeSeverity', () => {
  it('标准值原样返回', () => {
    expect(normalizeSeverity('error')).toBe('error')
    expect(normalizeSeverity('warning')).toBe('warning')
    expect(normalizeSeverity('pass')).toBe('pass')
  })

  it('大小写与首尾空白不敏感', () => {
    expect(normalizeSeverity(' Error ')).toBe('error')
    expect(normalizeSeverity('WARNING')).toBe('warning')
  })

  it('认得常见同义词（中英文）', () => {
    expect(normalizeSeverity('critical')).toBe('error')
    expect(normalizeSeverity('严重')).toBe('error')
    expect(normalizeSeverity('minor')).toBe('warning')
    expect(normalizeSeverity('轻微')).toBe('warning')
    expect(normalizeSeverity('ok')).toBe('pass')
  })

  it('认不出来的级别按 warning 处理，不擅自升级为阻断', () => {
    expect(normalizeSeverity('???')).toBe('warning')
    expect(normalizeSeverity(undefined)).toBe('warning')
  })
})

describe('normalizeReviewResult', () => {
  it('解析标准格式', () => {
    const r = normalizeReviewResult({
      items: [{ category: '剧情', severity: 'error', quote: '原文', description: '矛盾' }],
      summary: '总评',
    })
    expect(r).toEqual({
      items: [{ category: '剧情', severity: 'error', quote: '原文', description: '矛盾' }],
      summary: '总评',
    })
  })

  it('兼容 issues / level / desc 等字段名偏差', () => {
    const r = normalizeReviewResult({ issues: [{ dimension: '角色', level: 'High', desc: '人设崩了' }] })
    expect(r?.items).toEqual([{ category: '角色', severity: 'error', quote: undefined, description: '人设崩了' }])
    expect(r?.summary).toBe('')
  })

  it('拿不到任何条目时返回 null（不能当成「没有问题」）', () => {
    expect(normalizeReviewResult(null)).toBeNull()
    expect(normalizeReviewResult('not json')).toBeNull()
    expect(normalizeReviewResult({ summary: '只有总评' })).toBeNull()
    expect(normalizeReviewResult({ items: [] })).toBeNull()
    expect(normalizeReviewResult({ items: [null, 'x'] })).toBeNull()
  })
})

describe('blockingCount', () => {
  const review = {
    items: [
      { category: 'a', severity: 'error' as const, description: '' },
      { category: 'b', severity: 'warning' as const, description: '' },
      { category: 'c', severity: 'pass' as const, description: '' },
    ],
    summary: '',
  }

  it('默认门控只计 error', () => {
    expect(blockingCount(review, 'error')).toBe(1)
  })

  it('严格门控同时计 error 与 warning', () => {
    expect(blockingCount(review, 'error+warning')).toBe(2)
  })
})
