import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type {
  RefWorkData, RefChapterMeta, RefDigestData, RefLineData, RefStageData, RefOutlineData,
} from '../../electron/repositories/reference-repository'

interface ReferenceState {
  works: RefWorkData[]
  selectedWorkId: number | null
  chapters: RefChapterMeta[]
  digests: RefDigestData[]
  lines: RefLineData[]
  stages: RefStageData[]
  outlineL2: RefOutlineData | null
  outlineL3: RefOutlineData | null
  loading: boolean
  loadWorks: () => Promise<void>
  selectWork: (id: number | null) => Promise<void>
  reloadSelected: () => Promise<void>
  deleteWork: (id: number) => Promise<void>
}

export const useReferenceStore = create<ReferenceState>((set, get) => ({
  works: [],
  selectedWorkId: null,
  chapters: [],
  digests: [],
  lines: [],
  stages: [],
  outlineL2: null,
  outlineL3: null,
  loading: false,

  loadWorks: async () => {
    const works = await ipc.invoke('db:ref-work-list')
    set({ works })
  },

  selectWork: async (id) => {
    set({ selectedWorkId: id })
    if (id === null) {
      set({ chapters: [], digests: [], lines: [], stages: [], outlineL2: null, outlineL3: null })
      return
    }
    await get().reloadSelected()
  },

  reloadSelected: async () => {
    const id = get().selectedWorkId
    if (id === null) return
    set({ loading: true })
    const [chapters, digests, lines, stages, outlineL2, outlineL3, works] = await Promise.all([
      ipc.invoke('db:ref-chapter-meta-list', id),
      ipc.invoke('db:ref-digest-list', id),
      ipc.invoke('db:ref-line-list', id),
      ipc.invoke('db:ref-stage-list', id),
      ipc.invoke('db:ref-outline-get', id, 'L2'),
      ipc.invoke('db:ref-outline-get', id, 'L3'),
      ipc.invoke('db:ref-work-list'),
    ])
    set({ chapters, digests, lines, stages, outlineL2, outlineL3, works, loading: false })
  },

  deleteWork: async (id) => {
    await ipc.invoke('db:ref-work-delete', id)
    if (get().selectedWorkId === id) await get().selectWork(null)
    await get().loadWorks()
  },
}))
