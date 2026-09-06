import { describe, expect, it } from 'vitest'
import {
  isChapterEnding,
  normalizeBookChapterEnding,
  normalizeChapterEndingOverride,
  resolveChapterEnding,
} from '../chapter-ending'

describe('resolveChapterEnding', () => {
  it('defaults missing book setting to cliffhanger', () => {
    expect(resolveChapterEnding(undefined, undefined)).toBe('cliffhanger')
    expect(normalizeBookChapterEnding('')).toBe('cliffhanger')
    expect(normalizeBookChapterEnding('auto')).toBe('cliffhanger')
  })

  it('uses book default when chapter inherits', () => {
    expect(resolveChapterEnding('smooth', '')).toBe('smooth')
    expect(resolveChapterEnding('smooth', undefined)).toBe('smooth')
    expect(resolveChapterEnding('cliffhanger', 'inherit')).toBe('cliffhanger')
    expect(normalizeChapterEndingOverride('')).toBe('')
    expect(normalizeChapterEndingOverride('inherit')).toBe('')
  })

  it('lets a chapter override the book', () => {
    expect(resolveChapterEnding('cliffhanger', 'smooth')).toBe('smooth')
    expect(resolveChapterEnding('smooth', 'cliffhanger')).toBe('cliffhanger')
    expect(isChapterEnding('smooth')).toBe(true)
  })
})
