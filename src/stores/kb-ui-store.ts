import { create } from 'zustand'

interface KbUiState {
  selectedDocId: string | null
  selectDoc: (id: string | null) => void
}

/** 侧栏点选文档 ↔ 中间预览 */
export const useKbUiStore = create<KbUiState>((set) => ({
  selectedDocId: null,
  selectDoc: (id) => set({ selectedDocId: id }),
}))
