import { describe, it, expect } from 'vitest'
import { parseDraftIdFromPath } from '../editor-persistence'

describe('parseDraftIdFromPath', () => {
  it('草稿与终稿伪路径都能解析出草稿 ID', () => {
    expect(parseDraftIdFromPath('vela://draft/42')).toBe(42)
    expect(parseDraftIdFromPath('vela://manuscript/7')).toBe(7)
  })

  it('非草稿路径返回 null，不会被当成草稿 ID 写库', () => {
    // 版本对比 Tab 的路径：不是某个草稿，不能写库
    expect(parseDraftIdFromPath('vela://draft/ch5')).toBeNull()
    expect(parseDraftIdFromPath('vela://core/premise')).toBeNull()
    expect(parseDraftIdFromPath('E:/novels/book/chapter_1.md')).toBeNull()
  })
})
