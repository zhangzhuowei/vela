import { describe, expect, it } from 'vitest'
import {
  exportCharacterToJson,
  exportCharactersToJson,
  parseCharacterImport,
} from '../character-io'
import type { CharacterData } from '../../../electron/repositories/character-repository'

function card(partial: Partial<CharacterData> & { name: string }): CharacterData {
  return {
    role: 'supporting',
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships: '',
    arc: '',
    notes: '',
    speechStyle: '',
    ...partial,
  }
}

describe('character json export', () => {
  it('exports a single card with kind and no local-only fields', () => {
    const json = exportCharacterToJson(
      card({
        name: '小铃铛',
        role: 'supporting',
        personality: '机灵',
        portraitPath: 'C:\\local\\portrait.png',
        _cid: 'x',
        _dbName: '小铃铛',
      } as CharacterData)
    )
    const raw = JSON.parse(json)
    expect(raw.kind).toBe('vela-character')
    expect(raw.name).toBe('小铃铛')
    expect(raw.personality).toBe('机灵')
    expect(raw.portraitPath).toBeUndefined()
    expect(raw._cid).toBeUndefined()
    expect(raw._dbName).toBeUndefined()
  })

  it('exports a pack of cards', () => {
    const json = exportCharactersToJson([card({ name: '苏林', role: 'protagonist' }), card({ name: '果果' })])
    const raw = JSON.parse(json)
    expect(raw.kind).toBe('vela-characters')
    expect(raw.characters).toHaveLength(2)
    expect(raw.characters[0].name).toBe('苏林')
  })
})

describe('character json import', () => {
  it('round-trips a single exported card', () => {
    const parsed = parseCharacterImport(exportCharacterToJson(card({ name: '甜甜', appearance: '粉色' })))
    expect(parsed).toHaveLength(1)
    expect(parsed?.[0].name).toBe('甜甜')
    expect(parsed?.[0].appearance).toBe('粉色')
    expect(parsed?.[0].role).toBe('supporting')
  })

  it('round-trips a pack', () => {
    const parsed = parseCharacterImport(
      exportCharactersToJson([card({ name: '苏林', role: 'protagonist' }), card({ name: '林雪雁' })])
    )
    expect(parsed?.map((c) => c.name)).toEqual(['苏林', '林雪雁'])
    expect(parsed?.[0].role).toBe('protagonist')
  })

  it('accepts a bare object or array without kind', () => {
    expect(parseCharacterImport(JSON.stringify({ name: '果果', role: 'minor' }))?.[0]).toMatchObject({
      name: '果果',
      role: 'minor',
    })
    expect(parseCharacterImport(JSON.stringify([{ name: 'A' }, { name: 'B' }]))?.map((c) => c.name)).toEqual([
      'A',
      'B',
    ])
  })

  it('rejects invalid payloads and drops nameless cards', () => {
    expect(parseCharacterImport('not json')).toBeNull()
    expect(parseCharacterImport('[]')).toBeNull()
    expect(parseCharacterImport(JSON.stringify({ characters: [{ name: '  ' }] }))).toBeNull()
    expect(parseCharacterImport(JSON.stringify({ name: '' }))).toBeNull()
  })

  it('normalizes unknown roles and stringifies fields', () => {
    const parsed = parseCharacterImport(
      JSON.stringify({ name: ' 小铃铛 ', role: 'npc', age: 12, currentState: { location: '广场', updatedAtChapter: 3 } })
    )
    expect(parsed?.[0].role).toBe('supporting')
    expect(parsed?.[0].age).toBe('12')
    expect(parsed?.[0].name).toBe('小铃铛')
    expect(parsed?.[0].currentState?.location).toBe('广场')
    expect(parsed?.[0].currentState?.updatedAtChapter).toBe(3)
  })
})
