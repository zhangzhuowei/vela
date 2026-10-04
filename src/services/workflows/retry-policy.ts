/**
 * LLM 调用的重试策略（纯函数，便于单测）
 *
 * - 可重试：限流 429、5xx、超时、网络抖动、服务端繁忙
 * - 不可重试：用户取消、鉴权失败（401/403）、其他 4xx（请求本身有问题，重试也一样）
 * - 等待时间：服务端给了 Retry-After 就按它来（有上限）；否则指数退避 + 抖动。
 *   抖动避免批量任务里多个请求在同一时刻一起重试、再次一起撞上限流
 */

/** 第一次重试的基准等待 */
export const RETRY_BASE_DELAY_MS = 2_000
/** 指数退避的上限 */
export const RETRY_MAX_DELAY_MS = 60_000
/** 服务端 Retry-After 的采纳上限（防止异常大的值让批量任务长时间停住） */
export const RETRY_AFTER_CAP_MS = 300_000

/** 可重试的瞬时错误：限流 / 服务器繁忙 / 超时 / 网络抖动 */
export function isRetriableErrorMessage(msg: string): boolean {
  return /\b(408|409|425|429|500|502|503|504|529)\b/.test(msg)
    || /too busy|busy now|timeout|timed out|rate.?limit|overload|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|服务器繁忙|请求过于频繁|超时|流式生成失败|Stream generation failed/i.test(msg)
}

/** 鉴权 / 权限错误：不应在同一模型上重试（换备用模型可能有用） */
export function isAuthErrorMessage(msg: string): boolean {
  return /\b(401|403)\b/.test(msg) || /unauthorized|invalid api key|forbidden|无效的?\s*api|鉴权失败/i.test(msg)
}

/**
 * 从错误文案中取出服务端建议的等待秒数。
 * 主进程在错误文案里带上 "[retry-after=Ns]"（见 electron/llm/http.ts 的 httpErrorMessage）。
 */
export function parseRetryAfterSeconds(msg: string): number | null {
  const m = /retry-after=(\d+(?:\.\d+)?)s/i.exec(msg)
  if (!m) return null
  const sec = Number(m[1])
  return Number.isFinite(sec) && sec >= 0 ? sec : null
}

/**
 * 第 attempt 次重试（从 0 开始计）前要等多久。
 * 有 Retry-After 用它（上限 RETRY_AFTER_CAP_MS）；否则 base × 2^attempt（上限 RETRY_MAX_DELAY_MS），
 * 再取其 50%~100% 的随机值作为抖动。
 */
export function computeRetryDelayMs(attempt: number, errorMessage: string, random: () => number = Math.random): number {
  const retryAfter = parseRetryAfterSeconds(errorMessage)
  if (retryAfter !== null) return Math.min(RETRY_AFTER_CAP_MS, Math.round(retryAfter * 1000))
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt))
  return Math.round(exp / 2 + random() * (exp / 2))
}
