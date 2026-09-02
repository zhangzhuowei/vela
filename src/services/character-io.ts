/**
 * 角色卡 JSON 导入 / 导出（纯函数，不碰 IPC）。
 * 单张 kind=vela-character；整包 kind=vela-characters。
 * 不导出本机人设图路径与前端 _cid/_dbName。
 */
import type { CharacterData, CharacterStateData } from '../../electron/repositories/character-repository'

export const CHARACTER_JSON_KIND = 'vela-character'
export const CHARACTER_PACK_JSON_KIND = 'vela-characters'

const ROLES = new Set(['protagonist', 'antagonist', 'supporting', 'minor'])

const TEXT_FIELDS = [
  'gender',
  'age',
  'appearance',
  'personality',
  'background',
  'abilities',
  'motivation',
  'relationships',
  'arc',
  'notes',
  'speechStyle',
  'imagePrompt',
] as const

function asString(value: unknown): string {
  if (value == null) return ''
  return String(value)
}

function normalizeRole(value: unknown): string {
  const role = asString(value).trim()
  return ROLES.has(role) ? role : 'supporting'
}

function parseState(raw: unknown): CharacterStateData | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const updatedAtChapter = Number(o.updatedAtChapter)
  return {
    location: asString(o.location),
    powerLevel: asString(o.powerLevel),
    physicalState: asString(o.physicalState),
    mentalState: asString(o.mentalState),
    keyItems: asString(o.keyItems),
    recentEvents: asString(o.recentEvents),
    knownInfo: asString(o.knownInfo),
    updatedAtChapter: Number.isFinite(updatedAtChapter) ? updatedAtChapter : 0,
  }
}

function pickExportable(card: CharacterData): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: card.name,
    role: normalizeRole(card.role),
  }
  for (const key of TEXT_FIELDS) {
    const value = card[key]
    if (typeof value === 'string' && value) out[key] = value
  }
  if (card.currentState && (card.currentState.updatedAtChapter ?? 0) > 0) {
    out.currentState = {
      location: card.currentState.location,
      powerLevel: card.currentState.powerLevel,
      physicalState: card.currentState.physicalState,
      mentalState: card.currentState.mentalState,
      keyItems: card.currentState.keyItems,
      recentEvents: card.currentState.recentEvents,
      knownInfo: card.currentState.knownInfo,
      updatedAtChapter: card.currentState.updatedAtChapter,
    }
  }
  return out
}

export function parseOneCharacter(raw: unknown): CharacterData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = asString(o.name).trim()
  if (!name) return null
  return {
    name,
    role: normalizeRole(o.role),
    gender: asString(o.gender),
    age: asString(o.age),
    appearance: asString(o.appearance),
    personality: asString(o.personality),
    background: asString(o.background),
    abilities: asString(o.abilities),
    motivation: asString(o.motivation),
    relationships: asString(o.relationships),
    arc: asString(o.arc),
    notes: asString(o.notes),
    speechStyle: asString(o.speechStyle),
    imagePrompt: asString(o.imagePrompt),
    currentState: parseState(o.currentState),
  }
}

function collectCards(raw: unknown): CharacterData[] {
  if (Array.isArray(raw)) {
    return raw.map(parseOneCharacter).filter((c): c is CharacterData => Boolean(c))
  }
  if (!raw || typeof raw !== 'object') return []
  const o = raw as Record<string, unknown>
  if (Array.isArray(o.characters)) {
    return o.characters.map(parseOneCharacter).filter((c): c is CharacterData => Boolean(c))
  }
  const one = parseOneCharacter(o)
  return one ? [one] : []
}

/** 解析导入 JSON：单张 / 整包 / 无 kind 的对象或数组。无效则 null。 */
export function parseCharacterImport(json: string): CharacterData[] | null {
  try {
    const cards = collectCards(JSON.parse(json))
    return cards.length > 0 ? cards : null
  } catch {
    return null
  }
}

export function exportCharacterToJson(card: CharacterData): string {
  return JSON.stringify({ kind: CHARACTER_JSON_KIND, ...pickExportable(card) }, null, 2)
}

export function exportCharactersToJson(cards: CharacterData[]): string {
  return JSON.stringify(
    {
      kind: CHARACTER_PACK_JSON_KIND,
      characters: cards.filter((c) => c.name.trim()).map(pickExportable),
    },
    null,
    2
  )
}
