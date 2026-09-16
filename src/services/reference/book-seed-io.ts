/**
 * 新书导入包（book seed）组包 / 解析 / 合并。纯函数，不碰 IPC。
 * 由拆书生成，在另一个项目的项目结构头部导入。角色卡走 character-io 的整包格式。
 */
import type { NovelConfig } from '../../shared/ipc-channels'
import type { CharacterData } from '../../../electron/repositories/character-repository'
import type { RefDigestData } from '../../../electron/repositories/reference-repository'
import { parseOneCharacter } from '../character-io'

export const BOOK_SEED_KIND = 'vela.book-seed'
export const BOOK_SEED_VERSION = 1

const PLOT_STRUCTURES = new Set(['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'])
const POVS = new Set(['third_limited', 'first_person', 'third_omniscient', 'multi_pov'])

const TEXT_KEYS = [
  'genre', 'subGenre', 'targetAudience', 'coreOutline', 'worldSetting',
  'goldenFinger', 'protagonistProfile', 'globalGuidance', 'writingStyle',
] as const
const ARCH_KEYS = ['premise', 'characters', 'worldbuilding', 'synopsis'] as const

export type BookSeedNovelConfig = Partial<Pick<NovelConfig,
  (typeof TEXT_KEYS)[number] | 'plotStructure' | 'narrativePOV' | 'totalChapters' | 'wordsPerChapter'>>

export interface BookSeedArchitecture { premise: string; characters: string; worldbuilding: string; synopsis: string }

export interface BookSeedSource { workName: string; instruction: string; modelId: string; generatedAt: string }

export interface BookSeedFile {
  kind: typeof BOOK_SEED_KIND
  version: typeof BOOK_SEED_VERSION
  source: BookSeedSource
  novelConfig?: BookSeedNovelConfig
  architecture?: BookSeedArchitecture
}

/** 逐章摘要送入方式：不带 / 精简（每章一行，等距抽样）/ 全部（超预算自动降到精简） */
export type BookSeedDigestMode = 'none' | 'brief' | 'full'
export const BOOK_SEED_DIGEST_MODES: readonly BookSeedDigestMode[] = ['none', 'brief', 'full']

export interface BookSeedOptions {
  config: boolean
  architecture: boolean
  characters: boolean
  /** 沿用范文的人物与专名（默认关：只借结构，不带范文人名地名） */
  reuseNames: boolean
  digestMode: BookSeedDigestMode
}

/** 精简档最多取多少章；全部档的字数预算 */
export const DIGEST_BRIEF_MAX = 60
export const DIGEST_FULL_MAX_CHARS = 60000
/** 用户要求文本上限，与 electron/ipc-validation validateRefExportInput 一致 */
export const BOOK_SEED_INSTRUCTION_MAX = 8000

function digestBriefLine(d: RefDigestData): string {
  return `第${d.chapterNumber}章｜${d.summary}｜钩子:${d.hook || '（无）'}`
}

function digestFullLine(d: RefDigestData): string {
  const parts = [
    `第${d.chapterNumber}章`,
    d.summary,
    `事件:${d.events.length ? d.events.join('；') : '（无）'}`,
    `钩子:${d.hook || '（无）'}`,
    `主攻:${d.activeLine || '（无）'}`,
  ]
  if (d.intimate) parts.push('亲密')
  return parts.join('｜')
}

/** 等距抽样，首尾必取（结局对结构参考最要紧） */
function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  if (max <= 1) return [items[0]]
  const last = items.length - 1
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * last) / (max - 1))])
  return out
}

/** 把 L0 逐章摘要压成提示词文本。全部档超预算时降为精简并标记 downgraded。 */
export function buildDigestPromptText(
  digests: RefDigestData[],
  mode: BookSeedDigestMode,
  limits: { briefMax?: number; fullMaxChars?: number } = {},
): { text: string; mode: BookSeedDigestMode; downgraded: boolean } {
  if (mode === 'none') return { text: '', mode: 'none', downgraded: false }
  const briefMax = limits.briefMax ?? DIGEST_BRIEF_MAX
  const fullMaxChars = limits.fullMaxChars ?? DIGEST_FULL_MAX_CHARS
  const sorted = digests.filter((d) => d.status === 'ok').slice().sort((a, b) => a.chapterNumber - b.chapterNumber)
  if (mode === 'full') {
    const text = sorted.map(digestFullLine).join('\n')
    if (text.length <= fullMaxChars) return { text, mode: 'full', downgraded: false }
    return { text: sampleEvenly(sorted, briefMax).map(digestBriefLine).join('\n'), mode: 'brief', downgraded: true }
  }
  return { text: sampleEvenly(sorted, briefMax).map(digestBriefLine).join('\n'), mode: 'brief', downgraded: false }
}

/** 当前项目里会被导入覆盖的那部分 */
export interface BookSeedTarget {
  novelConfig: Partial<NovelConfig>
  core: { premise?: string; charactersArch?: string; worldbuilding?: string; synopsis?: string }
}

const ARCH_TO_CORE = { premise: 'premise', characters: 'charactersArch', worldbuilding: 'worldbuilding', synopsis: 'synopsis' } as const
type CoreArchKey = (typeof ARCH_TO_CORE)[keyof typeof ARCH_TO_CORE]

function str(v: unknown): string { return v == null ? '' : String(v) }

function posInt(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function pickNovelConfig(raw: unknown): BookSeedNovelConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const out: BookSeedNovelConfig = {}
  for (const k of TEXT_KEYS) {
    const v = str(o[k]).trim()
    if (v) out[k] = v
  }
  const ps = str(o.plotStructure)
  if (PLOT_STRUCTURES.has(ps)) out.plotStructure = ps as NovelConfig['plotStructure']
  const pov = str(o.narrativePOV)
  if (POVS.has(pov)) out.narrativePOV = pov as NovelConfig['narrativePOV']
  const tc = posInt(o.totalChapters)
  if (tc !== undefined) out.totalChapters = tc
  const wpc = posInt(o.wordsPerChapter)
  if (wpc !== undefined) out.wordsPerChapter = wpc
  return Object.keys(out).length ? out : undefined
}

function pickArchitecture(raw: unknown): BookSeedArchitecture | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const out: BookSeedArchitecture = { premise: '', characters: '', worldbuilding: '', synopsis: '' }
  let any = false
  for (const k of ARCH_KEYS) {
    out[k] = str(o[k]).trim()
    if (out[k]) any = true
  }
  return any ? out : undefined
}

export function buildBookSeedFile(input: BookSeedSource & { options: BookSeedOptions; llmResult: Record<string, unknown> }): BookSeedFile {
  const { options, llmResult, ...source } = input
  const file: BookSeedFile = { kind: BOOK_SEED_KIND, version: BOOK_SEED_VERSION, source }
  if (options.config) {
    const nc = pickNovelConfig(llmResult.novelConfig)
    if (nc) file.novelConfig = nc
  }
  if (options.architecture) {
    const arch = pickArchitecture(llmResult.architecture)
    if (arch) file.architecture = arch
  }
  return file
}

export function extractSeedCharacters(llmResult: Record<string, unknown>): CharacterData[] {
  const list = llmResult.characters
  if (!Array.isArray(list)) return []
  return list.map(parseOneCharacter).filter((c): c is CharacterData => Boolean(c))
}

export function parseBookSeedImport(json: string): BookSeedFile | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.kind !== BOOK_SEED_KIND || Number(o.version) !== BOOK_SEED_VERSION) return null
  const src = (o.source && typeof o.source === 'object' ? o.source : {}) as Record<string, unknown>
  const file: BookSeedFile = {
    kind: BOOK_SEED_KIND, version: BOOK_SEED_VERSION,
    source: { workName: str(src.workName), instruction: str(src.instruction), modelId: str(src.modelId), generatedAt: str(src.generatedAt) },
  }
  const nc = pickNovelConfig(o.novelConfig)
  if (nc) file.novelConfig = nc
  const arch = pickArchitecture(o.architecture)
  if (arch) file.architecture = arch
  return file.novelConfig || file.architecture ? file : null
}

/** 两边都非空才算覆盖；返回 `novelConfig.genre` / `architecture.premise` 形式的 key */
export function diffOverwrites(current: BookSeedTarget, seed: BookSeedFile): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(seed.novelConfig ?? {})) {
    const cur = current.novelConfig[k as keyof NovelConfig]
    const curFilled = typeof cur === 'number' ? cur > 0 : Boolean(str(cur).trim())
    if (v !== undefined && v !== '' && curFilled) out.push(`novelConfig.${k}`)
  }
  for (const k of ARCH_KEYS) {
    const v = seed.architecture?.[k]
    if (v && str(current.core[ARCH_TO_CORE[k]]).trim()) out.push(`architecture.${k}`)
  }
  return out
}

/** 只产出要写的字段：空字符串不写，章数字数 seed 没给就不写（保留当前值） */
export function applyBookSeed(_current: BookSeedTarget, seed: BookSeedFile): {
  novelConfig: Partial<NovelConfig>
  core: Partial<Record<CoreArchKey, string>>
} {
  const novelConfig: Partial<NovelConfig> = {}
  for (const [k, v] of Object.entries(seed.novelConfig ?? {})) {
    if (v === undefined || v === '' || v === 0) continue
    ;(novelConfig as Record<string, unknown>)[k] = v
  }
  const core: Partial<Record<CoreArchKey, string>> = {}
  for (const k of ARCH_KEYS) {
    const v = seed.architecture?.[k]
    if (v) core[ARCH_TO_CORE[k]] = v
  }
  return { novelConfig, core }
}

/** 按目录自身的分隔符风格拼文件路径；渲染进程没有 node:path */
export function joinExportPath(dir: string, fileName: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${fileName}`
}

export function bookSeedFileNames(workName: string, generatedAt: string): { book: string; characters: string } {
  const safe = workName.trim().replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  const stamp = generatedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const base = safe ? `${safe}-${stamp}` : `book-seed-${stamp}`
  return { book: `${base}.book.json`, characters: `${base}.characters.json` }
}
