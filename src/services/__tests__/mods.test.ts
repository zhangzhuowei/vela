import { describe, expect, it } from 'vitest'
import {
  collectTags,
  exportModToJson,
  filterModsByTag,
  mergeModGuidance,
  normalizeEnabledEntries,
  parseModImport,
  pickModSnapshot,
  resolveModTemplate,
  type ModVersion,
  type WritingMod,
} from '../mods'

function mod(id: string, over: Partial<WritingMod> = {}): WritingMod {
  return {
    id,
    name: id,
    description: '',
    version: 1,
    updatedAt: '',
    templates: {},
    guidanceAppend: '',
    ...over,
  }
}

describe('mod template resolution', () => {
  it('later enabled mods win on template conflicts', () => {
    const pool = new Map<string, WritingMod>([
      ['a', mod('a', { templates: { dialogue_scene: '来自A' } })],
      ['b', mod('b', { templates: { dialogue_scene: '来自B' } })],
    ])
    expect(resolveModTemplate('dialogue_scene', ['a', 'b'], pool)).toBe('来自B')
    expect(resolveModTemplate('dialogue_scene', ['b', 'a'], pool)).toBe('来自A')
  })

  it('skips mods without the key and ignores blank overrides', () => {
    const pool = new Map<string, WritingMod>([
      ['a', mod('a', { templates: { dialogue_scene: '来自A' } })],
      ['b', mod('b', { templates: { dialogue_distill: '蒸馏B', dialogue_scene: '  ' } })],
    ])
    expect(resolveModTemplate('dialogue_scene', ['a', 'b'], pool)).toBe('来自A')
    expect(resolveModTemplate('dialogue_distill', ['a', 'b'], pool)).toBe('蒸馏B')
    expect(resolveModTemplate('first_chapter_draft', ['a', 'b'], pool)).toBeUndefined()
  })

  it('returns undefined when nothing enabled', () => {
    const pool = new Map<string, WritingMod>([['a', mod('a', { templates: { x: 'X' } })]])
    expect(resolveModTemplate('x', [], pool)).toBeUndefined()
  })
})

describe('mod tags', () => {
  const tagged = (id: string, tags?: string[]) => mod(id, { tags })

  it('collects tags with counts, sorted by usage', () => {
    const all = [
      tagged('a', ['尺度', '节奏']),
      tagged('b', ['尺度']),
      tagged('c', ['文风', ' 尺度 ']),
      tagged('d'),
    ]
    expect(collectTags(all)).toEqual([
      { tag: '尺度', count: 3 },
      { tag: '文风', count: 1 },
      { tag: '节奏', count: 1 },
    ])
  })

  it('filters mods by tag and returns all when tag is null', () => {
    const all = [tagged('a', ['尺度']), tagged('b', ['节奏']), tagged('c')]
    expect(filterModsByTag(all, '尺度').map((m) => m.id)).toEqual(['a'])
    expect(filterModsByTag(all, null).length).toBe(3)
    expect(filterModsByTag(all, '不存在')).toEqual([])
  })
})

describe('mod enable entries and version pinning', () => {
  it('normalizes legacy string[] and new entry[] formats', () => {
    expect(normalizeEnabledEntries(['a', 'b'])).toEqual([
      { id: 'a', version: null },
      { id: 'b', version: null },
    ])
    expect(normalizeEnabledEntries([{ id: 'a', version: 2 }, { id: 'b' }, 'c', 42, null])).toEqual([
      { id: 'a', version: 2 },
      { id: 'b', version: null },
      { id: 'c', version: null },
    ])
    expect(normalizeEnabledEntries('junk')).toEqual([])
  })

  it('picks current mod when following latest, snapshot when pinned', () => {
    const current = mod('a', { version: 3, guidanceAppend: 'v3内容' })
    const history: ModVersion[] = [
      { version: 3, savedAt: '', snapshot: current },
      { version: 2, savedAt: '', snapshot: mod('a', { version: 2, guidanceAppend: 'v2内容' }) },
    ]
    expect(pickModSnapshot({ id: 'a', version: null }, current, history)?.guidanceAppend).toBe('v3内容')
    expect(pickModSnapshot({ id: 'a', version: 2 }, current, history)?.guidanceAppend).toBe('v2内容')
    // 钉住的版本在历史里找不到时回退当前版
    expect(pickModSnapshot({ id: 'a', version: 99 }, current, history)?.guidanceAppend).toBe('v3内容')
    expect(pickModSnapshot({ id: 'a', version: 2 }, undefined, history)).toBeUndefined()
  })
})

describe('mod import/export', () => {
  it('round-trips export → import parse', () => {
    const source = mod('x', {
      name: '破甲向',
      description: '尺度规则',
      templates: { dialogue_scene: '覆盖内容' },
      guidanceAppend: '【破甲写法】…',
      tags: ['尺度'],
    })
    const parsed = parseModImport(exportModToJson(source))
    expect(parsed).toEqual({
      name: '破甲向',
      description: '尺度规则',
      templates: { dialogue_scene: '覆盖内容' },
      guidanceAppend: '【破甲写法】…',
      tags: ['尺度'],
    })
  })

  it('rejects invalid payloads and normalizes junk fields', () => {
    expect(parseModImport('not json')).toBeNull()
    expect(parseModImport('{"description":"没有名字"}')).toBeNull()
    const parsed = parseModImport(
      JSON.stringify({ name: ' N ', templates: { a: '', b: 'ok', c: 42 }, tags: ['t', '', 3], guidanceAppend: 7 })
    )
    expect(parsed).toEqual({
      name: 'N',
      description: '',
      templates: { b: 'ok' },
      guidanceAppend: '',
      tags: ['t'],
    })
  })
})

describe('mod guidance merge', () => {
  it('joins guidance in enable order and skips empties', () => {
    const pool = new Map<string, WritingMod>([
      ['pojia', mod('pojia', { guidanceAppend: '【破甲写法】…' })],
      ['fast', mod('fast', { guidanceAppend: '【快节奏】…' })],
      ['empty', mod('empty')],
    ])
    expect(mergeModGuidance(['pojia', 'empty', 'fast'], pool)).toBe('【破甲写法】…\n\n【快节奏】…')
    expect(mergeModGuidance([], pool)).toBe('')
  })
})
