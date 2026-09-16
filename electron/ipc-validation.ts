/**
 * IPC Input Validation —— 主进程入口的统一校验层
 *
 * 目的：防止：
 *   - DoS via 巨型 string（1GB statement 直接落 SQLite）
 *   - Type confusion（renderer 发错字段类型）
 *   - Data corruption（type 不在 enum 内）
 *
 * 设计：
 *   - 不引入 zod/valibot 依赖（PR 体积敏感），用纯 TS 实现最小校验
 *   - 校验失败抛 ValidationError，主进程 handler 捕获并返回 { success: false, error }
 *   - 校验器都返回 boolean 或 throw，不修改原对象
 */
import { REF_FUNCS, REF_STAGES, coerceCharacterState } from '../src/services/reference/digest-state'

export class ValidationError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`[IPC Validation] ${path}: ${reason}`)
    this.name = 'ValidationError'
  }
}

// ============================================================
// 通用校验
// ============================================================

export function isString(v: unknown): v is string {
  return typeof v === 'string'
}

export function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function isInteger(v: unknown): v is number {
  return isNumber(v) && Number.isInteger(v)
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean'
}

export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// 字符串长度限制
export function checkStringLength(
  v: unknown,
  path: string,
  options: { min?: number; max: number },
): string {
  if (!isString(v)) {
    throw new ValidationError(path, `expected string, got ${typeof v}`)
  }
  if (v.length < (options.min ?? 0)) {
    throw new ValidationError(path, `too short (min ${options.min ?? 0}, got ${v.length})`)
  }
  if (v.length > options.max) {
    throw new ValidationError(path, `too long (max ${options.max}, got ${v.length})`)
  }
  return v
}

// 数字范围
export function checkNumberRange(
  v: unknown,
  path: string,
  options: { min?: number; max?: number; integer?: boolean },
): number {
  const ok = options.integer ? isInteger(v) : isNumber(v)
  if (!ok) {
    throw new ValidationError(path, `expected ${options.integer ? 'integer' : 'number'}, got ${typeof v}`)
  }
  const num = v as number
  if (options.min !== undefined && num < options.min) {
    throw new ValidationError(path, `below min ${options.min} (got ${num})`)
  }
  if (options.max !== undefined && num > options.max) {
    throw new ValidationError(path, `above max ${options.max} (got ${num})`)
  }
  return num
}

// 枚举
export function checkEnum<T extends string>(
  v: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (!isString(v) || !allowed.includes(v as T)) {
    throw new ValidationError(
      path,
      `expected one of [${allowed.join(', ')}], got ${JSON.stringify(v)}`,
    )
  }
  return v as T
}

// 数组
export function checkArray<T>(
  v: unknown,
  path: string,
  itemCheck: (item: unknown, itemPath: string) => T,
  options: { minLength?: number; maxLength: number },
): T[] {
  if (!isArray(v)) {
    throw new ValidationError(path, `expected array, got ${typeof v}`)
  }
  if (v.length < (options.minLength ?? 0)) {
    throw new ValidationError(path, `array too short (min ${options.minLength ?? 0}, got ${v.length})`)
  }
  if (v.length > options.maxLength) {
    throw new ValidationError(path, `array too long (max ${options.maxLength}, got ${v.length})`)
  }
  return v.map((item, i) => itemCheck(item, `${path}[${i}]`))
}

// 必需字段
export function checkRequired<T>(
  v: unknown,
  path: string,
  check: (v: unknown, path: string) => T,
): T {
  if (v === undefined || v === null) {
    throw new ValidationError(path, `required field missing`)
  }
  return check(v, path)
}

// 可选字段
export function checkOptional<T>(
  v: unknown,
  path: string,
  check: (v: unknown, path: string) => T,
): T | undefined {
  if (v === undefined || v === null) return undefined
  return check(v, path)
}

// ============================================================
// 领域校验（Canon Store 相关）
// ============================================================

const MAX_STATEMENT_LEN = 500
const MAX_EVIDENCE_LEN = 500
const MAX_NAME_LEN = 200
const MAX_SUMMARY_LEN = 5000
const MAX_LIST_SIZE = 1000
const MAX_OBJECTS_PER_REQUEST = 1000

export const VALID_CATEGORIES = [
  'world', 'location', 'item', 'event', 'relationship', 'identity',
] as const

export const VALID_TIMEFLOW = ['sequential', 'flashback'] as const

export const VALID_PLOT_STATUS = ['active', 'resolved', 'paused'] as const

export function validateCanonTimelineEventInput(v: unknown, path = 'event') {
  if (!isObject(v)) {
    throw new ValidationError(path, 'expected object')
  }
  return {
    chapterNumber: checkNumberRange(v.chapterNumber, `${path}.chapterNumber`, { min: 1, max: 1e9, integer: true }),
    sequence: checkNumberRange(v.sequence, `${path}.sequence`, { min: 1, max: 1e6, integer: true }),
    characters: checkArray(v.characters, `${path}.characters`, (c, p) => checkStringLength(c, p, { max: 50 }), { maxLength: MAX_LIST_SIZE }),
    location: checkStringLength(v.location, `${path}.location`, { max: 200 }),
    timeFlow: checkEnum(v.timeFlow, `${path}.timeFlow`, VALID_TIMEFLOW),
    summary: checkStringLength(v.summary, `${path}.summary`, { max: 500 }),
    impact: checkOptional(v.impact, `${path}.impact`, (s, p) => checkStringLength(s, p, { max: 500 })) ?? '',
  }
}

export function validateCanonFactInput(v: unknown, path = 'fact') {
  if (!isObject(v)) {
    throw new ValidationError(path, 'expected object')
  }
  return {
    category: checkEnum(v.category, `${path}.category`, VALID_CATEGORIES),
    statement: checkStringLength(v.statement, `${path}.statement`, { min: 1, max: MAX_STATEMENT_LEN }),
    introducedAt: checkNumberRange(v.introducedAt, `${path}.introducedAt`, { min: 0, max: 1e9, integer: true }),
    characters: checkArray(v.characters, `${path}.characters`, (c, p) => checkStringLength(c, p, { max: 50 }), { maxLength: MAX_LIST_SIZE }),
    evidence: checkOptional(v.evidence, `${path}.evidence`, (s, p) => checkStringLength(s, p, { max: MAX_EVIDENCE_LEN })) ?? '',
  }
}

export function validateCanonPlotLineInput(v: unknown, path = 'plotLine') {
  if (!isObject(v)) {
    throw new ValidationError(path, 'expected object')
  }
  return {
    name: checkStringLength(v.name, `${path}.name`, { min: 1, max: MAX_NAME_LEN }),
    status: checkEnum(v.status, `${path}.status`, VALID_PLOT_STATUS),
    startedAt: checkNumberRange(v.startedAt, `${path}.startedAt`, { min: 0, max: 1e9, integer: true }),
    lastAdvancedAt: checkNumberRange(v.lastAdvancedAt, `${path}.lastAdvancedAt`, { min: 0, max: 1e9, integer: true }),
    resolvedAt: checkOptional(v.resolvedAt, `${path}.resolvedAt`, (n, p) => checkNumberRange(n, p, { min: 0, max: 1e9, integer: true })),
    characters: checkArray(v.characters, `${path}.characters`, (c, p) => checkStringLength(c, p, { max: 50 }), { maxLength: MAX_LIST_SIZE }),
    currentState: checkStringLength(v.currentState, `${path}.currentState`, { max: 1000 }),
    description: checkOptional(v.description, `${path}.description`, (s, p) => checkStringLength(s, p, { max: 1000 })) ?? '',
  }
}

export function validateCanonCharacterStateSnapshot(v: unknown, path = 'snapshot', opts: { requireCharacter?: boolean } = {}) {
  const { requireCharacter = true } = opts
  if (!isObject(v)) {
    throw new ValidationError(path, 'expected object')
  }
  return {
    // delta.after 是 Partial<CharacterStateSnapshot>（角色名在 delta 顶层的 character），
    // 此时 character 允许缺省；独立快照 upsert 仍要求 character 必填。
    character: requireCharacter
      ? checkStringLength(v.character, `${path}.character`, { min: 1, max: MAX_NAME_LEN })
      : checkStringLength(v.character ?? '', `${path}.character`, { max: MAX_NAME_LEN }),
    location: checkStringLength(v.location ?? '', `${path}.location`, { max: 200 }),
    powerLevel: checkStringLength(v.powerLevel ?? '', `${path}.powerLevel`, { max: 200 }),
    physicalState: checkStringLength(v.physicalState ?? '', `${path}.physicalState`, { max: 500 }),
    mentalState: checkStringLength(v.mentalState ?? '', `${path}.mentalState`, { max: 500 }),
    keyItems: checkStringLength(v.keyItems ?? '', `${path}.keyItems`, { max: 500 }),
    currentGoal: checkStringLength(v.currentGoal ?? '', `${path}.currentGoal`, { max: 1000 }),
    knowledge: checkArray(v.knowledge ?? [], `${path}.knowledge`, (c, p) => checkStringLength(c, p, { max: 500 }), { maxLength: MAX_LIST_SIZE }),
    relationships: isObject(v.relationships) ? v.relationships as Record<string, string> : {},
    recentEvents: checkStringLength(v.recentEvents ?? '', `${path}.recentEvents`, { max: 1000 }),
    updatedAtChapter: checkNumberRange(v.updatedAtChapter ?? 0, `${path}.updatedAtChapter`, { min: 0, max: 1e9, integer: true }),
    updatedAt: checkStringLength(v.updatedAt ?? '', `${path}.updatedAt`, { max: 100 }),
  }
}

export function validateCanonChapterSummary(v: unknown, path = 'summary') {
  if (!isObject(v)) {
    throw new ValidationError(path, 'expected object')
  }
  return {
    chapterNumber: checkNumberRange(v.chapterNumber, `${path}.chapterNumber`, { min: 0, max: 1e9, integer: true }),
    title: checkStringLength(v.title ?? '', `${path}.title`, { max: 500 }),
    summary: checkStringLength(v.summary, `${path}.summary`, { min: 0, max: MAX_SUMMARY_LEN }),
    createdAt: checkStringLength(v.createdAt ?? '', `${path}.createdAt`, { max: 100 }),
  }
}

export function validateCanonWritebackPayload(v: unknown, path = 'payload') {
  if (!isObject(v)) {
    throw new ValidationError(path, 'expected object')
  }
  return {
    chapterNumber: checkNumberRange(v.chapterNumber, `${path}.chapterNumber`, { min: 1, max: 1e9, integer: true }),
    newEvents: checkArray(
      v.newEvents,
      `${path}.newEvents`,
      (e, p) => validateCanonTimelineEventInput(e, p),
      { maxLength: MAX_OBJECTS_PER_REQUEST },
    ),
    characterDeltas: checkArray(
      v.characterDeltas,
      `${path}.characterDeltas`,
      (d, p) => {
        if (!isObject(d)) throw new ValidationError(p, 'expected object')
        return {
          character: checkStringLength(d.character, `${p}.character`, { min: 1, max: MAX_NAME_LEN }),
          chapterNumber: checkNumberRange(d.chapterNumber, `${p}.chapterNumber`, { min: 1, max: 1e9, integer: true }),
          after: validateCanonCharacterStateSnapshot(d.after, `${p}.after`, { requireCharacter: false }),
        }
      },
      { maxLength: MAX_OBJECTS_PER_REQUEST },
    ),
    plotLineChanges: checkOptional(v.plotLineChanges, `${path}.plotLineChanges`, (pl, p) => {
      if (!isObject(pl)) throw new ValidationError(p, 'expected object')
      return {
        added: checkOptional(pl.added, `${p}.added`, (a, ap) =>
          checkArray(a, ap, (item, iap) => validateCanonPlotLineInput(item, iap), { maxLength: 500 })),
        advanced: checkOptional(pl.advanced, `${p}.advanced`, (a, ap) =>
          checkArray(a, ap, (item, iap) => {
            if (!isObject(item)) throw new ValidationError(iap, 'expected object')
            return {
              id: checkNumberRange(item.id, `${iap}.id`, { min: 1, max: 1e9, integer: true }),
              currentState: checkStringLength(item.currentState, `${iap}.currentState`, { max: 1000 }),
              lastAdvancedAt: checkNumberRange(item.lastAdvancedAt, `${iap}.lastAdvancedAt`, { min: 0, max: 1e9, integer: true }),
            }
          }, { maxLength: 500 })),
        resolved: checkOptional(pl.resolved, `${p}.resolved`, (a, ap) =>
          checkArray(a, ap, (n, ip) => checkNumberRange(n, ip, { min: 1, max: 1e9, integer: true }), { maxLength: 500 })),
      }
    }),
    newFacts: checkArray(
      v.newFacts,
      `${path}.newFacts`,
      (f, p) => validateCanonFactInput(f, p),
      { maxLength: MAX_OBJECTS_PER_REQUEST },
    ),
  }
}

// ============================================================
// 领域校验（设定纲要模块）
// ============================================================

export const VALID_SETTING_INJECT_MODES = ['always', 'retrieval', 'off'] as const

export function validateSettingModuleInput(v: unknown, path = 'module') {
  if (!isObject(v)) {
    throw new ValidationError(path, 'expected object')
  }
  return {
    id: checkOptional(v.id, `${path}.id`, (n, p) => checkNumberRange(n, p, { min: 0, max: 1e9, integer: true })),
    key: checkStringLength(v.key, `${path}.key`, { min: 1, max: 100 }),
    title: checkStringLength(v.title, `${path}.title`, { max: 100 }),
    sortOrder: checkNumberRange(v.sortOrder ?? 0, `${path}.sortOrder`, { min: 0, max: 1e6, integer: true }),
    injectMode: checkEnum(v.injectMode ?? 'retrieval', `${path}.injectMode`, VALID_SETTING_INJECT_MODES),
    body: checkStringLength(v.body ?? '', `${path}.body`, { max: 30000 }),
    summary: checkStringLength(v.summary ?? '', `${path}.summary`, { max: 1000 }),
    source: checkEnum(v.source ?? 'user', `${path}.source`, ['ai', 'user'] as const),
    kbDocId: checkStringLength(v.kbDocId ?? '', `${path}.kbDocId`, { max: 100 }),
  }
}

export function validateBranchInput(v: unknown, path = 'branch') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    id: checkOptional(v.id, `${path}.id`, (n, p) => checkNumberRange(n, p, { min: 0, max: 1e6, integer: true })),
    name: checkStringLength(v.name, `${path}.name`, { min: 1, max: 60 }),
    kind: checkEnum(v.kind ?? 'extra', `${path}.kind`, ['extra', 'if'] as const),
    anchorKind: checkEnum(v.anchorKind ?? 'chapter', `${path}.anchorKind`, ['chapter', 'reference_stage'] as const),
    anchorChapter: checkNumberRange(v.anchorChapter ?? 0, `${path}.anchorChapter`, { min: 0, max: 9999, integer: true }),
    premise: checkStringLength(v.premise ?? '', `${path}.premise`, { max: 2000 }),
    settingDiff: checkStringLength(v.settingDiff ?? '', `${path}.settingDiff`, { max: 8000 }),
    sortOrder: checkNumberRange(v.sortOrder ?? 0, `${path}.sortOrder`, { min: 0, max: 1e6, integer: true }),
  }
}

export function validateVisibility(v: unknown, path = 'visibility') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    mainUpTo: checkNumberRange(v.mainUpTo, `${path}.mainUpTo`, { min: 0, max: 9999, integer: true }),
    branchId: checkNumberRange(v.branchId, `${path}.branchId`, { min: 0, max: 1e6, integer: true }),
    branchFrom: checkNumberRange(v.branchFrom, `${path}.branchFrom`, { min: 0, max: 1e10, integer: true }),
    branchUpTo: checkNumberRange(v.branchUpTo, `${path}.branchUpTo`, { min: 0, max: 1e10, integer: true }),
  }
}

const VALID_REF_STATUS = ['idle', 'running', 'done', 'error'] as const
const VALID_REF_STAGE = REF_STAGES
const VALID_REF_FUNC = REF_FUNCS
const VALID_REF_KIND = ['romance', 'plot', 'other'] as const

function checkStringArray(v: unknown, path: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ValidationError(path, 'expected array')
  if (v.length > maxItems) throw new ValidationError(path, `too many items (>${maxItems})`)
  return v.map((s, i) => checkStringLength(s, `${path}[${i}]`, { max: maxLen }))
}

export function validateRefWorkInput(v: unknown, path = 'refWork') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    id: checkOptional(v.id, `${path}.id`, (n, p) => checkNumberRange(n, p, { min: 0, max: 1e9, integer: true })),
    name: checkStringLength(v.name, `${path}.name`, { min: 1, max: 200 }),
    sourceFiles: checkStringArray(v.sourceFiles, `${path}.sourceFiles`, 500, 1000),
    totalChapters: checkNumberRange(v.totalChapters ?? 0, `${path}.totalChapters`, { min: 0, max: 1e6, integer: true }),
    totalWords: checkNumberRange(v.totalWords ?? 0, `${path}.totalWords`, { min: 0, max: 1e9, integer: true }),
    analyzedFrom: checkNumberRange(v.analyzedFrom ?? 0, `${path}.analyzedFrom`, { min: 0, max: 1e6, integer: true }),
    analyzedTo: checkNumberRange(v.analyzedTo ?? 0, `${path}.analyzedTo`, { min: 0, max: 1e6, integer: true }),
    digestModelId: checkStringLength(v.digestModelId ?? '', `${path}.digestModelId`, { max: 200 }),
    outlineModelId: checkStringLength(v.outlineModelId ?? '', `${path}.outlineModelId`, { max: 200 }),
    status: checkEnum(v.status ?? 'idle', `${path}.status`, VALID_REF_STATUS),
  }
}

export function validateRefDigestInput(v: unknown, path = 'refDigest') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  const statesRaw = v.characterStates ?? []
  if (!Array.isArray(statesRaw)) throw new ValidationError(`${path}.characterStates`, 'expected array')
  const characterStates = statesRaw.slice(0, 60).map((s, i) => {
    if (!isObject(s)) throw new ValidationError(`${path}.characterStates[${i}]`, 'expected object')
    const coerced = coerceCharacterState({
      name: typeof s.name === 'string' ? s.name : '',
      stage: s.stage,
      func: s.func,
    })
    return {
      name: checkStringLength(coerced.name, `${path}.characterStates[${i}].name`, { min: 1, max: 60 }),
      stage: checkEnum(coerced.stage, `${path}.characterStates[${i}].stage`, VALID_REF_STAGE),
      func: checkEnum(coerced.func, `${path}.characterStates[${i}].func`, VALID_REF_FUNC),
    }
  })
  const introducedRaw = v.introduced ?? []
  if (!Array.isArray(introducedRaw)) throw new ValidationError(`${path}.introduced`, 'expected array')
  const introduced = introducedRaw.slice(0, 30).map((s, i) => {
    if (!isObject(s)) throw new ValidationError(`${path}.introduced[${i}]`, 'expected object')
    return {
      name: checkStringLength(s.name, `${path}.introduced[${i}].name`, { min: 1, max: 60 }),
      by: checkStringLength(s.by ?? '', `${path}.introduced[${i}].by`, { max: 60 }),
    }
  })
  return {
    workId: checkNumberRange(v.workId, `${path}.workId`, { min: 1, max: 1e9, integer: true }),
    chapterNumber: checkNumberRange(v.chapterNumber, `${path}.chapterNumber`, { min: 1, max: 1e6, integer: true }),
    summary: checkStringLength(v.summary ?? '', `${path}.summary`, { max: 4000 }),
    events: checkStringArray(v.events, `${path}.events`, 30, 500),
    hook: checkStringLength(v.hook ?? '', `${path}.hook`, { max: 500 }),
    activeLine: checkStringLength(v.activeLine ?? '', `${path}.activeLine`, { max: 60 }),
    characterStates,
    introduced,
    intimate: Boolean(v.intimate),
    status: checkEnum(v.status ?? 'ok', `${path}.status`, ['ok', 'failed'] as const),
    error: checkStringLength(v.error ?? '', `${path}.error`, { max: 2000 }),
  }
}

export function validateRefLineInput(v: unknown, path = 'refLine') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    id: checkOptional(v.id, `${path}.id`, (n, p) => checkNumberRange(n, p, { min: 0, max: 1e9, integer: true })),
    workId: checkNumberRange(v.workId, `${path}.workId`, { min: 1, max: 1e9, integer: true }),
    name: checkStringLength(v.name, `${path}.name`, { min: 1, max: 60 }),
    aliases: checkStringArray(v.aliases, `${path}.aliases`, 30, 60),
    kind: checkEnum(v.kind ?? 'romance', `${path}.kind`, VALID_REF_KIND),
    sortOrder: checkNumberRange(v.sortOrder ?? 0, `${path}.sortOrder`, { min: 0, max: 1e6, integer: true }),
    locked: Boolean(v.locked),
    arcSummary: checkStringLength(v.arcSummary ?? '', `${path}.arcSummary`, { max: 6000 }),
  }
}

export function validateRefStageInput(v: unknown, path = 'refStage') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  const fromChapter = checkNumberRange(v.fromChapter, `${path}.fromChapter`, { min: 1, max: 1e6, integer: true })
  const toChapter = checkNumberRange(v.toChapter, `${path}.toChapter`, { min: 1, max: 1e6, integer: true })
  if (fromChapter > toChapter) throw new ValidationError(`${path}.toChapter`, 'must be >= fromChapter')
  return {
    id: checkOptional(v.id, `${path}.id`, (n, p) => checkNumberRange(n, p, { min: 0, max: 1e9, integer: true })),
    workId: checkNumberRange(v.workId, `${path}.workId`, { min: 1, max: 1e9, integer: true }),
    seq: checkNumberRange(v.seq ?? 0, `${path}.seq`, { min: 0, max: 1e6, integer: true }),
    title: checkStringLength(v.title ?? '', `${path}.title`, { max: 200 }),
    fromChapter,
    toChapter,
    goal: checkStringLength(v.goal ?? '', `${path}.goal`, { max: 2000 }),
    antagonist: checkStringLength(v.antagonist ?? '', `${path}.antagonist`, { max: 500 }),
    entryHook: checkStringLength(v.entryHook ?? '', `${path}.entryHook`, { max: 1000 }),
    exitPeak: checkStringLength(v.exitPeak ?? '', `${path}.exitPeak`, { max: 1000 }),
    locked: Boolean(v.locked),
  }
}

export function validateRefOutlineInput(v: unknown, path = 'refOutline') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    workId: checkNumberRange(v.workId, `${path}.workId`, { min: 1, max: 1e9, integer: true }),
    level: checkEnum(v.level, `${path}.level`, ['L2', 'L3'] as const),
    body: checkStringLength(v.body ?? '', `${path}.body`, { max: 60000 }),
    force: Boolean(v.force),
  }
}

export function validateRefRevisionInput(v: unknown, path = 'refRevision') {
  if (!isObject(v)) throw new ValidationError(path, 'expected object')
  return {
    workId: checkNumberRange(v.workId, `${path}.workId`, { min: 1, max: 1e9, integer: true }),
    scope: checkEnum(v.scope, `${path}.scope`, ['L2', 'L3', 'stage', 'line', 'digest'] as const),
    targetId: checkNumberRange(v.targetId ?? 0, `${path}.targetId`, { min: 0, max: 1e9, integer: true }),
    instruction: checkStringLength(v.instruction ?? '', `${path}.instruction`, { max: 4000 }),
    before: checkStringLength(v.before ?? '', `${path}.before`, { max: 200000 }),
    after: checkStringLength(v.after ?? '', `${path}.after`, { max: 200000 }),
  }
}

/**
 * 安全调用 validator 包装器：捕获 ValidationError 并返回 { success, error }
 * 用于 ipcMain.handle 内部
 */
export function safeValidate<T>(validator: (v: unknown) => T, raw: unknown): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: validator(raw) }
  } catch (e) {
    if (e instanceof ValidationError) {
      return { ok: false, error: e.message }
    }
    throw e
  }
}
