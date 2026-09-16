import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { invalidateBranchCache } from '../services/branches/branch-service'
import { globalEventBus } from '../shared/event-bus'
import type { BranchData, BranchInput } from '../../electron/repositories/branch-repository'

interface BranchState {
  branches: BranchData[]
  load: () => Promise<void>
  save: (data: BranchInput) => Promise<{ success: boolean; id?: number; error?: string }>
  remove: (id: number) => Promise<{ success: boolean; error?: string }>
  reset: () => void
}

export const useBranchStore = create<BranchState>((set, get) => ({
  branches: [],
  load: async () => {
    set({ branches: await ipc.invoke('db:branch-list').catch(() => [] as BranchData[]) })
  },
  save: async (data) => {
    const res = await ipc.invoke('db:branch-upsert', data)
    if (res.success) {
      invalidateBranchCache()
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['branches'] })
      await get().load()
    }
    return res
  },
  remove: async (id) => {
    const res = await ipc.invoke('db:branch-delete', id)
    if (res.success) {
      invalidateBranchCache()
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['branches'] })
      await get().load()
    }
    return res
  },
  reset: () => {
    invalidateBranchCache()
    set({ branches: [] })
  },
}))
