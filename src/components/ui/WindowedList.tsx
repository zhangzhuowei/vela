/**
 * WindowedList —— 依附最近可滚动祖先的定高行虚拟列表
 *
 * 侧栏的草稿箱/正文稿/会话历史都是"有多少条渲染多少个 DOM 节点"，
 * 百章以上项目展开分组时一次性构建上千节点，滚动与刷新都随条数线性变贵。
 * 本组件只渲染滚动视口（含上下 overscan 缓冲）内的行：
 *
 *  - 行高固定（number）或按行给定（函数，内部做前缀和），不做动态测量
 *  - 不自带滚动条：向上查找最近的 overflow-y:auto/scroll 祖先并跟随其滚动，
 *    保持侧栏"单一滚动条"的现有交互不变
 *  - 低于 threshold 条数时直接平铺渲染（小项目零额外开销、DOM 结构与原先一致）
 *  - 除滚动/缩放外，同一滚动容器内其他分组的折叠展开会让本列表整体位移；
 *    这类布局变化在侧栏里都由点击驱动，故在捕获阶段监听父容器 click，
 *    下一帧（React 已提交 DOM 后）重算窗口
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

interface WindowedListProps<T> {
  items: T[]
  /** 行高（px）：恒定值或按行返回 */
  itemHeight: number | ((item: T, index: number) => number)
  /** 渲染单行；返回的元素无需带 key（由外层包裹节点提供） */
  renderItem: (item: T, index: number) => ReactNode
  /** 视口上下各多渲染的像素缓冲 */
  overscanPx?: number
  /** 低于该条数直接平铺渲染 */
  threshold?: number
}

/** 向上查找最近的可滚动祖先 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

export default function WindowedList<T>({
  items,
  itemHeight,
  renderItem,
  overscanPx = 400,
  threshold = 80,
}: WindowedListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 40 })

  const uniform = typeof itemHeight === 'number' ? itemHeight : null

  // 变高行的前缀和（恒定行高走等差快路径，不建表）
  const offsets = useMemo(() => {
    if (uniform != null) return null
    const heightOf = itemHeight as (item: T, index: number) => number
    const arr = new Array<number>(items.length + 1)
    arr[0] = 0
    for (let i = 0; i < items.length; i++) arr[i + 1] = arr[i] + heightOf(items[i], i)
    return arr
  }, [items, itemHeight, uniform])

  const totalHeight = uniform != null ? uniform * items.length : (offsets ? offsets[items.length] : 0)
  const virtualize = items.length > threshold

  useEffect(() => {
    if (!virtualize) return
    const container = containerRef.current
    if (!container) return
    const scrollParent = findScrollParent(container)
    if (!scrollParent) return

    let raf = 0
    const recompute = () => {
      raf = 0
      const c = containerRef.current
      if (!c) return
      const parentRect = scrollParent.getBoundingClientRect()
      const rect = c.getBoundingClientRect()
      // 滚动视口映射到本列表坐标系内的可见区间（含缓冲）
      const viewTop = parentRect.top - rect.top - overscanPx
      const viewBottom = parentRect.bottom - rect.top + overscanPx
      let start: number
      let end: number
      if (uniform != null) {
        start = Math.max(0, Math.floor(viewTop / uniform))
        end = Math.max(start, Math.min(items.length, Math.ceil(viewBottom / uniform)))
      } else {
        const offs = offsets as number[]
        start = 0
        while (start < items.length && offs[start + 1] < viewTop) start++
        end = start
        while (end < items.length && offs[end] < viewBottom) end++
      }
      setRange(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(recompute)
    }

    recompute()
    scrollParent.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    scrollParent.addEventListener('click', schedule, true)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scrollParent.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      scrollParent.removeEventListener('click', schedule, true)
    }
  }, [virtualize, items, uniform, offsets, overscanPx])

  if (!virtualize) {
    return <>{items.map((item, i) => <Fragment key={i}>{renderItem(item, i)}</Fragment>)}</>
  }

  const start = Math.min(range.start, items.length)
  const end = Math.min(range.end, items.length)
  const visible: ReactNode[] = []
  for (let i = start; i < end; i++) {
    const top = uniform != null ? i * uniform : (offsets as number[])[i]
    const height = uniform != null ? uniform : (offsets as number[])[i + 1] - (offsets as number[])[i]
    visible.push(
      <div key={i} style={{ position: 'absolute', top, left: 0, right: 0, height }}>
        {renderItem(items[i], i)}
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', height: totalHeight }}>
      {visible}
    </div>
  )
}
