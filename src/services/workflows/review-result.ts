/**
 * 审稿结果的结构与归一化（纯函数，便于单测）
 *
 * 审稿命令要求模型输出 {"items":[{category,severity,quote?,description}],"summary"}，
 * 但模型的字段名、严重级别写法经常有偏差。这里统一归一化；拿不到任何条目时返回 null，
 * 由调用方按「审稿结果不可用」处理，绝不能当成「没有问题」（此前会得到阻断数 0，直接判通过）。
 */

export interface ReviewItem {
  category: string
  severity: 'error' | 'warning' | 'pass'
  quote?: string
  description: string
}

export interface ReviewResult {
  items: ReviewItem[]
  summary: string
}

export type ReviewGate = 'error' | 'error+warning'

/** 统计阻断级问题数量 */
export function blockingCount(r: ReviewResult, gate: ReviewGate): number {
  if (!r || !Array.isArray(r.items)) return 0
  return r.items.filter(
    (it) => it.severity === 'error' || (gate === 'error+warning' && it.severity === 'warning'),
  ).length
}

/** 模型常见的严重级别写法 → 标准值 */
const SEVERITY_ALIASES: Record<string, ReviewItem['severity']> = {
  error: 'error', errors: 'error', critical: 'error', severe: 'error', major: 'error', high: 'error',
  fatal: 'error', blocker: 'error', '严重': 'error', '错误': 'error', '重大': 'error', '阻断': 'error',
  warning: 'warning', warn: 'warning', warnings: 'warning', medium: 'warning', moderate: 'warning',
  minor: 'warning', low: 'warning', '警告': 'warning', '轻微': 'warning', '一般': 'warning',
  pass: 'pass', passed: 'pass', ok: 'pass', none: 'pass', info: 'pass', '通过': 'pass', '无': 'pass',
}

/** 严重级别归一：大小写、同义词都认；认不出来的按 warning 处理（是问题，但不擅自升级为阻断） */
export function normalizeSeverity(value: unknown): ReviewItem['severity'] {
  const key = String(value ?? '').trim().toLowerCase()
  return SEVERITY_ALIASES[key] ?? 'warning'
}

/**
 * 审稿结果结构归一：兼容常见的字段名偏差（issues / level / desc 等）。
 * 拿不到任何审稿条目时返回 null。模板要求每个维度至少输出一条记录（无问题也要写 pass），
 * 所以空列表同样视为无效结果，而不是「没有问题」。
 */
export function normalizeReviewResult(raw: unknown): ReviewResult | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const list = [obj.items, obj.issues, obj.problems].find(Array.isArray) as unknown[] | undefined
  if (!list) return null

  const items: ReviewItem[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const it = entry as Record<string, unknown>
    items.push({
      category: String(it.category ?? it.dimension ?? it.type ?? ''),
      severity: normalizeSeverity(it.severity ?? it.level),
      quote: typeof it.quote === 'string' ? it.quote : undefined,
      description: String(it.description ?? it.desc ?? it.detail ?? it.issue ?? ''),
    })
  }
  if (items.length === 0) return null
  return { items, summary: typeof obj.summary === 'string' ? obj.summary : '' }
}
