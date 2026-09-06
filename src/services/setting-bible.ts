/**
 * 设定纲要（Setting Bible）— 纯函数部分
 *
 * 一个模块 = 世界怎么运转的一条规则文档，固定四格：
 *   规则（怎样算对）/ 例外（谁能破、代价）/ 进戏（怎样变成冲突）/ 禁止（不许怎么写）
 *
 * 写稿时两条出口：
 *   - 常驻（always）：摘要拼成 setting_digest，每章、每场都带
 *   - 按需（retrieval）：正文同步进本书知识库，靠检索或点名取用
 * 本文件不碰 IPC，方便单测；落库与知识库同步见 setting-bible-service.ts
 */
import type { SettingModuleData, SettingInjectMode } from '../../electron/repositories/setting-module-repository'

export type { SettingModuleData, SettingInjectMode }

export const GRID_KEYS = ['规则', '例外', '进戏', '禁止'] as const
export type GridKey = (typeof GRID_KEYS)[number]
export type SettingGrid = Record<GridKey, string>

/** 常驻摘要总预算（字）。超了页面标红，逼用户把不常用的改成按需 */
export const DIGEST_BUDGET = 1500
/** 单模块摘要上限（字） */
export const SUMMARY_MAX = 200

// ---------------------------------------------------------------------------
// 默认模块清单（按类型）
// ---------------------------------------------------------------------------

export interface DefaultModuleSpec {
  key: string
  title: string
  /** 给生成提示词看的：这个模块要回答什么 */
  hint: string
  injectMode?: SettingInjectMode
}

const PROTAGONIST: DefaultModuleSpec = {
  key: 'protagonist',
  title: '主角配置',
  hint: '主角在上述各项制度里的位置：出身层级、婚姻/关系状态、等级或评级、手里有什么资源、哪些手段不能用、必须守哪些规矩、成长轴往哪条制度的哪一级走',
  injectMode: 'always',
}

const ANCIENT: DefaultModuleSpec[] = [
  { key: 'social_strata', title: '社会分层与权力', hint: '阶层怎么划、各层掌握什么、越阶通道是什么、谁说了算', injectMode: 'always' },
  { key: 'marriage', title: '婚姻继承与联姻禁区', hint: '谁能娶谁、正室侧室门槛、继承顺位、越级婚配算什么、退婚悔婚的后果' },
  { key: 'beauty_rank', title: '美貌与声名等级', hint: '几级、谁来评、每级对应哪些权利和禁区、评级怎样升降、名声毁了会怎样' },
  { key: 'etiquette', title: '称呼礼仪与公开场合', hint: '尊卑称呼、见礼规矩、公开场合什么不能做、失仪的代价' },
  { key: 'economy', title: '经济与资源', hint: '嫁妆、封地、俸禄、人情债怎么算，钱和权怎样互换' },
  { key: 'taboo', title: '禁忌与破例代价', hint: '绝对不能碰的事、碰了谁来罚、怎么罚、有没有赦免通道' },
  PROTAGONIST,
]

const FANTASY: DefaultModuleSpec[] = [
  { key: 'power_system', title: '力量体系与瓶颈', hint: '境界/等级划分、每级质变是什么、卡在哪、怎么突破、代价是什么', injectMode: 'always' },
  { key: 'factions', title: '宗门势力与资源分配', hint: '几大势力、各自掌握什么、资源怎么分、外人怎么进' },
  { key: 'treasure_trade', title: '天材地宝与交易规则', hint: '什么值钱、怎么估价、黑市与明市、抢夺算不算合法' },
  { key: 'karma_taboo', title: '因果禁忌与代价', hint: '不可越界的规则、破界的反噬、天道或宗门怎么追责' },
  PROTAGONIST,
]

const MODERN: DefaultModuleSpec[] = [
  { key: 'circles', title: '圈层与阶层', hint: '圈子怎么分、进出门槛、彼此怎么看对方、跨圈层的代价', injectMode: 'always' },
  { key: 'workplace', title: '职场或行业规则', hint: '明规则暗规则、晋升通道、谁掌握生死、什么事做了就出局' },
  { key: 'love_family', title: '婚恋与家庭观念', hint: '家里对婚恋的期待、门当户对怎么算、离婚出轨的社会后果' },
  { key: 'money_favor', title: '金钱与人情', hint: '钱能买什么不能买什么、人情债怎样还、面子怎么算' },
  PROTAGONIST,
]

const SCIFI: DefaultModuleSpec[] = [
  { key: 'tech_rules', title: '科技规则与限制', hint: '核心技术能做什么不能做什么、代价与副作用、谁掌握', injectMode: 'always' },
  { key: 'governance', title: '统治结构与阶层', hint: '谁在管、怎样分层、底层怎样活、越阶通道' },
  { key: 'resources', title: '资源与生存规则', hint: '最稀缺的是什么、怎样分配、争夺的边界' },
  { key: 'taboo', title: '禁忌与惩罚', hint: '绝对禁区、违反后的处置、有没有例外' },
  PROTAGONIST,
]

const FANFIC: DefaultModuleSpec[] = [
  { key: 'canon_hard', title: '原作硬设定（不得改动）', hint: '原作已定、本书绝不改的规则：世界规则、角色关系底线、力量或身份限制。写陈述句，不写候选', injectMode: 'always' },
  { key: 'divergence', title: '本书改动与衍生设定', hint: '本书相对原作改了什么、新增了什么、这些改动的边界' },
  { key: 'social_strata', title: '社会分层与权力', hint: '阶层怎么划、各层掌握什么、越阶通道是什么' },
  { key: 'marriage', title: '婚恋与关系规则', hint: '谁能和谁在一起、公开与私下的边界、破坏关系的代价' },
  { key: 'taboo', title: '禁忌与破例代价', hint: '绝对不能碰的事、碰了谁来罚、怎么罚' },
  PROTAGONIST,
]

const GENERIC: DefaultModuleSpec[] = [
  { key: 'social_strata', title: '社会制度与阶层', hint: '阶层怎么划、各层掌握什么、越阶通道', injectMode: 'always' },
  { key: 'marriage', title: '婚姻与关系制度', hint: '谁能和谁结合、门槛与禁区、破坏的代价' },
  { key: 'economy', title: '经济与资源', hint: '什么稀缺、怎样分配、钱与权怎样互换' },
  { key: 'taboo', title: '禁忌与惩罚', hint: '绝对禁区、违反后的处置、例外通道' },
  PROTAGONIST,
]

/** 按小说配置的 genre 给默认模块清单 */
export function defaultModulesForGenre(genre: string): DefaultModuleSpec[] {
  const g = (genre || '').trim()
  if (['古言', '历史', '武侠', '宫廷'].includes(g)) return ANCIENT
  if (['玄幻', '仙侠', '奇幻'].includes(g)) return FANTASY
  if (['都市', '现言', '职场', '言情', '悬疑', '灵异'].includes(g)) return MODERN
  if (['科幻', '末世', '游戏', '军事'].includes(g)) return SCIFI
  if (g === '同人' || g === '轻小说') return FANFIC
  return GENERIC
}

// ---------------------------------------------------------------------------
// 四格 Markdown
// ---------------------------------------------------------------------------

export function emptyGrid(): SettingGrid {
  return { 规则: '', 例外: '', 进戏: '', 禁止: '' }
}

/** 把 `## 规则 …` 四段解析成格子；没有任何标题时整段落进「规则」 */
export function parseGrid(body: string): SettingGrid {
  const grid = emptyGrid()
  const text = (body || '').replace(/\r\n?/g, '\n')
  const re = /^##\s*(规则|例外|进戏|禁止)\s*$/gm
  const hits: Array<{ key: GridKey; start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    hits.push({ key: m[1] as GridKey, start: m.index, end: m.index + m[0].length })
  }
  if (hits.length === 0) {
    grid.规则 = text.replace(/^#\s.*\n?/, '').trim()
    return grid
  }
  hits.forEach((h, i) => {
    const next = hits[i + 1]
    const chunk = text.slice(h.end, next ? next.start : undefined).trim()
    grid[h.key] = grid[h.key] ? `${grid[h.key]}\n${chunk}` : chunk
  })
  return grid
}

export function serializeGrid(grid: SettingGrid): string {
  return GRID_KEYS.map((k) => `## ${k}\n${(grid[k] || '').trim()}`).join('\n\n') + '\n'
}

export function isGridEmpty(body: string): boolean {
  const g = parseGrid(body)
  return GRID_KEYS.every((k) => !g[k].trim())
}

// ---------------------------------------------------------------------------
// 常驻摘要 → setting_digest
// ---------------------------------------------------------------------------

/** 摘要为空时用「规则」格的前一段兜底，保证常驻模块不至于静默消失 */
export function effectiveSummary(m: Pick<SettingModuleData, 'summary' | 'body'>): string {
  const s = (m.summary || '').trim()
  if (s) return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s
  const rule = parseGrid(m.body).规则.trim()
  if (!rule) return ''
  const firstPara = rule.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim()
  return firstPara.length > SUMMARY_MAX ? firstPara.slice(0, SUMMARY_MAX) : firstPara
}

/** 常驻模块摘要总字数（预算提示用） */
export function digestChars(modules: SettingModuleData[]): number {
  return modules
    .filter((m) => m.injectMode === 'always')
    .map((m) => ({ title: m.title, text: effectiveSummary(m) }))
    .filter((x) => x.text)
    .reduce((n, x) => n + x.title.length + x.text.length + 3, 0)
}

const DIGEST_HEADER =
  '【设定纲要 · 本世界运转规则】（优先级：低于人物当前状态与已发生事实，高于故事架构与知识库资料；只按规则写人怎么做，禁止旁白式科普这些规则）'

/**
 * 拼常驻摘要。没有可用模块时返回空串，模板里的「（如有）」标签会被自动裁掉。
 */
export function buildSettingDigest(modules: SettingModuleData[]): string {
  const lines = modules
    .filter((m) => m.injectMode === 'always')
    .map((m) => ({ title: m.title.trim(), text: effectiveSummary(m) }))
    .filter((x) => x.title && x.text)
    .map((x) => `- ${x.title}：${x.text}`)
  if (lines.length === 0) return ''
  return `${DIGEST_HEADER}\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// 知识库出口
// ---------------------------------------------------------------------------

export const KB_FILE_PREFIX = '设定·'

export function kbFileName(title: string): string {
  const safe = (title || '未命名').replace(/[\\/:*?"<>|]/g, '·').trim()
  return `${KB_FILE_PREFIX}${safe}.md`
}

/** 写进知识库的正文：标题打头，让每个切块都能被「设定名」召回 */
export function kbDocumentText(m: Pick<SettingModuleData, 'title' | 'body'>): string {
  const grid = parseGrid(m.body)
  const parts = GRID_KEYS.filter((k) => grid[k].trim()).map((k) => `【${m.title}·${k}】${grid[k].trim()}`)
  return parts.join('\n\n')
}

export function newCustomKey(): string {
  return `custom_${Date.now().toString(36)}`
}
