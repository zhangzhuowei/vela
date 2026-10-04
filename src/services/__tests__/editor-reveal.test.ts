import { describe, it, expect } from 'vitest'
import {
  requestEditorReveal, takeEditorReveal, subscribeEditorReveal, resolveRevealRange, REVEAL_TTL_MS,
} from '../editor-reveal'

describe('resolveRevealRange', () => {
  const doc = '林风拔剑。\n林风收剑，转身离去。'

  it('原位置文本一致时直接使用', () => {
    const from = doc.indexOf('收剑')
    expect(resolveRevealRange(doc, { from, to: from + 2, text: '收剑' })).toEqual({ from, to: from + 2, exact: true })
  })

  it('内容有改动时取离原位置最近的同一文本', () => {
    const saved = '林风拔剑。' + '剑光如雪，'.repeat(10) + '\n林风收剑。'
    const dbOffset = saved.lastIndexOf('林风')
    // 编辑器里段首多了几个未保存的字，后文整体后移
    const edited = '（补）' + saved
    const second = edited.lastIndexOf('林风')
    expect(resolveRevealRange(edited, { from: dbOffset, to: dbOffset + 2, text: '林风' }))
      .toEqual({ from: second, to: second + 2, exact: true })
    // 离哪一处近就取哪一处
    const first = edited.indexOf('林风')
    expect(resolveRevealRange(edited, { from: first + 1, to: first + 3, text: '林风' }).from).toBe(first)
  })

  it('不区分大小写的搜索在就近定位时也不区分', () => {
    const text = 'Alice met ALICE'
    expect(resolveRevealRange(text, { from: 9, to: 14, text: 'alice' })).toEqual({ from: 10, to: 15, exact: true })
    expect(resolveRevealRange(text, { from: 9, to: 14, text: 'alice', caseSensitive: true })).toEqual({ from: 9, to: 9, exact: false })
  })

  it('找不到时只返回钳制到文档范围内的位置', () => {
    expect(resolveRevealRange(doc, { from: 999, to: 1001, text: '不存在' })).toEqual({ from: doc.length, to: doc.length, exact: false })
    expect(resolveRevealRange(doc, { from: -5, to: 0, text: '' })).toEqual({ from: 0, to: 0, exact: false })
  })
})

describe('定位请求登记与取走', () => {
  it('取走即删除，过期请求丢弃', () => {
    requestEditorReveal({ filePath: 'vela://draft/1', from: 1, to: 2, text: 'a' }, 1000)
    expect(takeEditorReveal('vela://draft/1', 1500)).toEqual({ filePath: 'vela://draft/1', from: 1, to: 2, text: 'a' })
    expect(takeEditorReveal('vela://draft/1', 1500)).toBeNull()

    requestEditorReveal({ filePath: 'vela://draft/2', from: 0, to: 1, text: 'b' }, 1000)
    expect(takeEditorReveal('vela://draft/2', 1000 + REVEAL_TTL_MS + 1)).toBeNull()
    // 过期的也已清掉，不会残留到以后
    expect(takeEditorReveal('vela://draft/2', 1000)).toBeNull()
  })

  it('同一文件只保留最新请求，并通知订阅者目标路径', () => {
    const seen: string[] = []
    const unsubscribe = subscribeEditorReveal(p => seen.push(p))
    requestEditorReveal({ filePath: 'vela://manuscript/3', from: 0, to: 1, text: 'x' })
    requestEditorReveal({ filePath: 'vela://manuscript/3', from: 5, to: 6, text: 'y' })
    unsubscribe()
    requestEditorReveal({ filePath: 'vela://manuscript/4', from: 0, to: 1, text: 'z' })

    expect(seen).toEqual(['vela://manuscript/3', 'vela://manuscript/3'])
    expect(takeEditorReveal('vela://manuscript/3')?.text).toBe('y')
    expect(takeEditorReveal('vela://manuscript/4')?.text).toBe('z')
  })

  it('订阅者在回调里取走请求后，挂载时不会重复处理', () => {
    const unsubscribe = subscribeEditorReveal(p => { takeEditorReveal(p) })
    requestEditorReveal({ filePath: 'vela://draft/9', from: 0, to: 1, text: 'q' })
    unsubscribe()
    expect(takeEditorReveal('vela://draft/9')).toBeNull()
  })
})
