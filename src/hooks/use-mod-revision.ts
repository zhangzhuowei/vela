import { useEffect, useState } from 'react'
import { getModRevision, subscribeModChanges } from '../services/mods'

/** 启用列表 / 章场排除变化时触发重渲染 */
export function useModRevision(): number {
  const [revision, setRevision] = useState(getModRevision)
  useEffect(() => subscribeModChanges(() => setRevision(getModRevision())), [])
  return revision
}
