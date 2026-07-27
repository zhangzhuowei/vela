import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type { CharacterData, CharacterStateData } from '../../electron/repositories/character-repository'
import i18n from '../i18n'

export type CharacterCurrentState = CharacterStateData
export type CharacterCard = CharacterData & {
  /** 仅前端内存使用的稳定 id，用于在改名时把内存卡与数据库行对应起来 */
  _cid?: string
  /**
   * 该卡当前在数据库里持久化的名字（主键）。
   * 改名时 name 变了但 _dbName 仍指向旧行，saveAll 据此发起原地改名，
   * 避免改名被当成新卡插入而产生重复。undefined = 尚未入库的新卡。
   */
  _dbName?: string
}

/** 生成前端稳定 id */
function newCid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }
}

export const EMPTY_CARD: CharacterCard = {
  name: '', role: 'supporting', gender: '', age: '',
  appearance: '', personality: '', background: '', abilities: '',
  motivation: '', relationships: '', arc: '', notes: '', speechStyle: '',
}

export const EMPTY_STATE: CharacterCurrentState = {
  location: '', powerLevel: '', physicalState: '', mentalState: '',
  keyItems: '', recentEvents: '', knownInfo: '', updatedAtChapter: 0,
}

export const ROLE_LABELS: Record<CharacterCard['role'], string> = {
  protagonist: i18n.t('characters.protagonist', { ns: 'panels' }),
  antagonist: i18n.t('characters.antagonist', { ns: 'panels' }),
  supporting: i18n.t('characters.supporting', { ns: 'panels' }),
  minor: i18n.t('characters.minor', { ns: 'panels' }),
}

interface CharacterState {
  characters: CharacterCard[]
  selectedName: string | null
  saving: boolean
  loaded: boolean

  load: () => Promise<void>
  reset: () => void
  setSelectedName: (name: string | null) => void
  addCharacter: () => void
  deleteCharacter: (name: string, projectPath?: string) => Promise<void>
  updateField: <K extends keyof CharacterCard>(name: string, key: K, value: CharacterCard[K]) => void
  saveAll: (projectPath?: string) => Promise<void>

  // 兼容旧接口
  loadCharacters: (projectPath: string) => Promise<void>
}

export const useCharacterStore = create<CharacterState>()((set, get) => ({
  characters: [],
  selectedName: null,
  saving: false,
  loaded: false,

  load: async () => {
    try {
      const cards = await ipc.invoke('db:character-get-all')

      const { selectedName } = get()
      // 记录每张卡入库时的名字（_dbName），改名检测用
      const tracked: CharacterCard[] = cards.map(c => ({ ...c, _cid: newCid(), _dbName: c.name }))
      set({
        characters: tracked,
        loaded: true,
        selectedName: cards.find(c => c.name === selectedName)
          ? selectedName
          : (cards.length > 0 ? cards[0].name : null),
      })
    } catch {
      set({ characters: [], selectedName: null, loaded: true })
    }
  },

  loadCharacters: async () => {
    await get().load()
  },

  reset: () => {
    set({ characters: [], selectedName: null, saving: false, loaded: false })
  },

  setSelectedName: (name) => set({ selectedName: name }),

  addCharacter: () => {
    const newCard: CharacterCard = {
      ...EMPTY_CARD,
      name: i18n.t('characters.newCharacter', { ns: 'panels' }) + Math.random().toString(36).slice(2, 6),
      _cid: newCid(),
      // 尚未入库：_dbName 保持 undefined，saveAll 时按新增插入
      _dbName: undefined,
    }
    set((s) => ({
      characters: [...s.characters, newCard],
      selectedName: newCard.name,
    }))
  },

  deleteCharacter: async (name) => {
    const { characters } = get()
    const card = characters.find(c => c.name === name)
    if (!card) return

    // SQLite 删除：按库中真实主键（_dbName）删，兼容"改了名但还没保存"的情况。
    // 删除不存在的名字是无害的空操作。
    const dbName = card._dbName ?? name
    try { await ipc.invoke('db:character-delete', dbName) } catch { /* 忽略 */ }

    const remaining = characters.filter(c => c.name !== name)
    set({
      characters: remaining,
      selectedName: remaining.length > 0 ? remaining[0].name : null,
    })
  },

  updateField: (name, key, value) => {
    set((s) => {
      const newChars = s.characters.map(c =>
        c.name === name ? { ...c, [key]: value } : c
      )

      let newSelected = s.selectedName
      if (key === 'name' && s.selectedName === name) {
        newSelected = value as string
      }

      return { characters: newChars, selectedName: newSelected }
    })
  },

  saveAll: async () => {
    set({ saving: true })
    const { characters } = get()

    try {
      // 1) 先处理改名：把库里旧名字的行原地改成新名字。
      //    否则 upsert(ON CONFLICT(name)) 会把新名字当成新卡插入，旧行残留 → 重复卡。
      for (const c of characters) {
        if (c._dbName && c._dbName !== c.name && c.name.trim()) {
          const res = await ipc.invoke('db:character-rename', c._dbName, c.name)
          if (!res?.success) {
            // 目标名多半已被占用：跳过改名，不中断整批。旧行保留，交由用户处理，
            // 避免静默覆盖同名卡造成数据丢失。
            console.warn('[characterStore] 改名失败:', c._dbName, '→', c.name, res?.error)
          }
        }
      }

      // 2) 批量 upsert（改名成功的行已在新名字下，命中更新而非插入）。
      //    剥离仅前端使用的 _cid/_dbName，不入库。
      const payload = characters.map((c) => {
        const clone: CharacterCard = { ...c }
        delete clone._cid
        delete clone._dbName
        return clone as CharacterData
      })
      await ipc.invoke('db:character-save-all', payload)

      // 3) 同步内存中的持久化名字快照，供下一次改名检测使用
      set((s) => ({
        characters: s.characters.map(c => ({ ...c, _dbName: c.name })),
      }))
    } finally {
      set({ saving: false })
    }
  },
}))
