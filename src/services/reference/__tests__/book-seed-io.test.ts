import { describe, it, expect } from 'vitest'
import {
  BOOK_SEED_KIND, BOOK_SEED_VERSION,
  buildBookSeedFile, extractSeedCharacters, parseBookSeedImport,
  diffOverwrites, applyBookSeed, bookSeedFileNames, buildDigestPromptText, joinExportPath,
  type BookSeedFile, type BookSeedOptions,
} from '../book-seed-io'
import type { RefDigestData } from '../../../../electron/repositories/reference-repository'

const source = { workName: '龙王的工作', instruction: '写一部碧蓝航线同人，主角是指挥官', modelId: 'qwen', generatedAt: '2026-09-16T08:00:00.000Z' }
const allOn: BookSeedOptions = { config: true, architecture: true, characters: true, reuseNames: false, digestMode: 'none' }

function digest(n: number, over: Partial<RefDigestData> = {}): RefDigestData {
  return {
    workId: 1, chapterNumber: n, summary: `第${n}章摘要`, events: [`事件${n}a`, `事件${n}b`], hook: `钩子${n}`,
    activeLine: '空银子', characterStates: [], introduced: [], intimate: n % 2 === 0, status: 'ok', error: '', updatedAt: '',
    ...over,
  }
}

describe('buildDigestPromptText', () => {
  it('returns empty text for none', () => {
    expect(buildDigestPromptText([digest(1)], 'none')).toEqual({ text: '', mode: 'none', downgraded: false })
  })
  it('brief: one line per chapter with summary and hook, sampled evenly and always keeping first and last', () => {
    const many = Array.from({ length: 10 }, (_, i) => digest(i + 1))
    const out = buildDigestPromptText(many, 'brief', { briefMax: 5 })
    const lines = out.text.split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('第1章｜第1章摘要｜钩子:钩子1')
    expect(lines[4]).toBe('第10章｜第10章摘要｜钩子:钩子10')
    expect(out.mode).toBe('brief')
  })
  it('brief keeps all chapters when under the cap', () => {
    const out = buildDigestPromptText([digest(1), digest(2), digest(3)], 'brief', { briefMax: 5 })
    expect(out.text.split('\n')).toHaveLength(3)
  })
  it('full: includes events, active line and intimacy, sorted by chapter', () => {
    const out = buildDigestPromptText([digest(2), digest(1)], 'full')
    expect(out.text.split('\n')[0]).toBe('第1章｜第1章摘要｜事件:事件1a；事件1b｜钩子:钩子1｜主攻:空银子')
    expect(out.text.split('\n')[1]).toContain('｜亲密')
    expect(out.downgraded).toBe(false)
  })
  it('full downgrades to brief when over the char budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => digest(i + 1, { summary: 'x'.repeat(400) }))
    const out = buildDigestPromptText(many, 'full', { fullMaxChars: 20000, briefMax: 60 })
    expect(out.mode).toBe('brief')
    expect(out.downgraded).toBe(true)
    expect(out.text.split('\n')).toHaveLength(60)
  })
})

describe('buildBookSeedFile', () => {
  it('keeps only whitelisted novelConfig fields and drops invalid enums', () => {
    const file = buildBookSeedFile({
      ...source, options: allOn,
      llmResult: {
        novelConfig: { genre: '同人', plotStructure: 'nope', narrativePOV: 'first_person', coreOutline: '大纲', hacker: 'x', totalChapters: '120' },
        architecture: { premise: 'P', characters: 'C', worldbuilding: 'W', synopsis: 'S', extra: 'E' },
      },
    })
    expect(file.kind).toBe(BOOK_SEED_KIND)
    expect(file.version).toBe(BOOK_SEED_VERSION)
    expect(file.source).toEqual(source)
    expect(file.novelConfig).toEqual({ genre: '同人', narrativePOV: 'first_person', coreOutline: '大纲', totalChapters: 120 })
    expect(file.architecture).toEqual({ premise: 'P', characters: 'C', worldbuilding: 'W', synopsis: 'S' })
  })

  it('omits sections that were not requested', () => {
    const file = buildBookSeedFile({
      ...source, options: { ...allOn, config: false, characters: false },
      llmResult: { novelConfig: { genre: 'x' }, architecture: { premise: 'P' } },
    })
    expect(file.novelConfig).toBeUndefined()
    expect(file.architecture).toEqual({ premise: 'P', characters: '', worldbuilding: '', synopsis: '' })
  })
})

describe('extractSeedCharacters', () => {
  it('returns parsed cards and skips nameless entries', () => {
    const cards = extractSeedCharacters({ characters: [{ name: '指挥官', role: 'protagonist' }, { name: ' ' }, { role: 'minor' }] })
    expect(cards.map((c) => c.name)).toEqual(['指挥官'])
    expect(cards[0].role).toBe('protagonist')
  })
  it('returns [] when characters is missing or not an array', () => {
    expect(extractSeedCharacters({})).toEqual([])
    expect(extractSeedCharacters({ characters: 'x' })).toEqual([])
  })
})

describe('parseBookSeedImport', () => {
  const valid = JSON.stringify({ kind: BOOK_SEED_KIND, version: 1, source, novelConfig: { genre: '同人' }, architecture: { premise: 'P' } })
  it('parses a valid file', () => {
    const f = parseBookSeedImport(valid)
    expect(f?.novelConfig?.genre).toBe('同人')
    expect(f?.architecture?.premise).toBe('P')
  })
  it('rejects wrong kind, unknown version, invalid json and empty payload', () => {
    expect(parseBookSeedImport(JSON.stringify({ kind: 'vela-characters', characters: [] }))).toBeNull()
    expect(parseBookSeedImport(JSON.stringify({ kind: BOOK_SEED_KIND, version: 99, novelConfig: { genre: 'x' } }))).toBeNull()
    expect(parseBookSeedImport('not json')).toBeNull()
    expect(parseBookSeedImport(JSON.stringify({ kind: BOOK_SEED_KIND, version: 1 }))).toBeNull()
  })
})

describe('diffOverwrites / applyBookSeed', () => {
  const current = {
    novelConfig: { genre: '玄幻', coreOutline: '', totalChapters: 200, wordsPerChapter: 3000 },
    core: { premise: '旧前提', charactersArch: '', worldbuilding: '', synopsis: '' },
  }
  const seed: BookSeedFile = {
    kind: BOOK_SEED_KIND, version: BOOK_SEED_VERSION, source,
    novelConfig: { genre: '同人', coreOutline: '新大纲' },
    architecture: { premise: '新前提', characters: '', worldbuilding: 'W', synopsis: '' },
  }
  it('lists only fields that are non-empty on both sides', () => {
    expect(diffOverwrites(current, seed)).toEqual(['novelConfig.genre', 'architecture.premise'])
  })
  it('merges, maps characters→charactersArch, keeps chapter counts when seed omits them, skips empty seed strings', () => {
    const out = applyBookSeed(current, seed)
    expect(out.novelConfig).toEqual({ genre: '同人', coreOutline: '新大纲' })
    expect(out.core).toEqual({ premise: '新前提', worldbuilding: 'W' })
  })
  it('passes chapter counts through when seed gives positive numbers', () => {
    const out = applyBookSeed(current, { ...seed, novelConfig: { totalChapters: 80, wordsPerChapter: 0 } })
    expect(out.novelConfig).toEqual({ totalChapters: 80 })
  })
})

describe('joinExportPath', () => {
  it('uses the separator style of the directory and strips trailing separators', () => {
    expect(joinExportPath('E:\\out\\', 'a.book.json')).toBe('E:\\out\\a.book.json')
    expect(joinExportPath('E:\\out', 'a.book.json')).toBe('E:\\out\\a.book.json')
    expect(joinExportPath('/home/u/out/', 'a.book.json')).toBe('/home/u/out/a.book.json')
    expect(joinExportPath('/home/u/out', 'a.book.json')).toBe('/home/u/out/a.book.json')
  })
})

describe('bookSeedFileNames', () => {
  it('sanitises the name and appends a timestamp', () => {
    const n = bookSeedFileNames('龙王/的:工作*', '2026-09-16T08:05:09.000Z')
    expect(n.book).toBe('龙王_的_工作_-20260916-080509.book.json')
    expect(n.characters).toBe('龙王_的_工作_-20260916-080509.characters.json')
  })
  it('falls back when the name is empty', () => {
    expect(bookSeedFileNames('   ', '2026-09-16T08:05:09.000Z').book).toBe('book-seed-20260916-080509.book.json')
  })
})
