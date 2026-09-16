import i18n from '../i18n'

/**
 * 格式化相对时间（如：刚刚 / 5分钟前 / 2小时前 / 3天前）
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return i18n.t('justNow', { ns: 'common' })
  if (minutes < 60) return i18n.t('minutesAgo', { ns: 'common', count: minutes })
  if (hours < 24) return i18n.t('hoursAgo', { ns: 'common', count: hours })
  if (days < 7) return i18n.t('daysAgo', { ns: 'common', count: days })
  return new Date(timestamp).toLocaleDateString(i18n.language === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' })
}

/**
 * SQLite `datetime('now')` 存的是无时区的 UTC 字串（"2026-09-16 08:00:00"），
 * 直接显示会比本地时间差一个时区；这里转成本地时间戳。解析失败返回 NaN。
 */
export function parseSqliteUtc(value: string): number {
  const iso = value.trim().replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
}

/** SQLite UTC 字串 → 本地化显示；解析失败原样返回 */
export function formatSqliteUtc(value: string, options?: Intl.DateTimeFormatOptions): string {
  const ts = parseSqliteUtc(value)
  return Number.isNaN(ts) ? value : formatDate(ts, options)
}

/**
 * 格式化日期为本地化字符串
 */
export function formatDate(timestamp: number, options?: Intl.DateTimeFormatOptions): string {
  const locale = i18n.language === 'en' ? 'en-US' : 'zh-CN'
  return new Date(timestamp).toLocaleString(locale, options ?? {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
