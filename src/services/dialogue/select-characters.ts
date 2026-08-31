/**
 * 对话创作模式 — 本场出场角色筛选
 *
 * 大工程角色卡可能有几十上百张，全量注入提示词会撑爆上下文。
 * 优先级：主角 > 蓝图出场角色 > 章内已有进行中状态的角色；超出上限截断。
 */
import type { WorkingState } from '../../shared/ipc-channels'

export type SelectableCharacter = { name: string; role?: string }

export function selectSceneCharacters<T extends SelectableCharacter>(params: {
  all: T[]
  blueprintCast: string[]
  workingState: WorkingState
  max?: number
}): T[] {
  const max = params.max ?? 12
  const cast = new Set(params.blueprintCast)
  const stateful = new Set(
    Object.entries(params.workingState)
      .filter(([, fields]) => Object.values(fields).some((v) => v && String(v).trim()))
      .map(([name]) => name)
  )

  const protagonists = params.all.filter((c) => c.role === 'protagonist')
  const inCast = params.all.filter((c) => c.role !== 'protagonist' && cast.has(c.name))
  const withState = params.all.filter(
    (c) => c.role !== 'protagonist' && !cast.has(c.name) && stateful.has(c.name)
  )

  const picked = [...protagonists, ...inCast, ...withState]
  // 完全没命中时退回全量（小工程场景），仍受上限保护
  const pool = picked.length > 0 ? picked : params.all
  return pool.slice(0, max)
}
