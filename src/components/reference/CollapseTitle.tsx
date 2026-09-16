import { ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  open: boolean
  onToggle: () => void
  title: string
  collapseLabel: string
  expandLabel: string
}

/** 可收起区块的标题行：箭头 + 标题，点击切换 */
export default function CollapseTitle({ open, onToggle, title, collapseLabel, expandLabel }: Props) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 min-w-0 text-left text-xs font-medium"
      title={open ? collapseLabel : expandLabel}
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? <ChevronDown size={12} className="flex-shrink-0" /> : <ChevronRight size={12} className="flex-shrink-0" />}
      <span className="truncate">{title}</span>
    </button>
  )
}
