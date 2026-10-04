/**
 * 主进程 HTTP 超时工具
 *
 * 此前所有模型请求都没有超时：服务端挂住时 invoke 永远不返回，流式请求卡在 reader.read()，
 * 无人值守的批量任务会永久停住。这里统一提供「连接超时 + 流空闲超时」，并与用户取消信号合并。
 *
 * 超时错误的文案带英文 "timeout"：渲染层 isRetriableError 按它判为可重试错误。
 */

/** 发出请求到收到响应头的最长时间（大模型排队、首包慢时要留足余量） */
export const CONNECT_TIMEOUT_MS = 120_000
/** 流式响应两段数据之间允许的最长静默（思考模型推理期间也会持续推送数据） */
export const STREAM_IDLE_TIMEOUT_MS = 180_000
/** 非流式请求（含读完响应体）的最长时间 */
export const REQUEST_TIMEOUT_MS = 300_000
/** Embedding 单批请求的最长时间 */
export const EMBEDDING_TIMEOUT_MS = 60_000

export interface TimeoutController {
  /** 传给 fetch 的信号：超时或外部取消都会触发 */
  readonly signal: AbortSignal
  /** 是否因超时而中止（区分「超时」与「用户取消」） */
  readonly timedOut: boolean
  /** 重新计时（流式收到新数据时调用），可换一个时长 */
  reset: (ms?: number) => void
  /** 停止计时并解绑外部信号（请求结束后必须调用） */
  dispose: () => void
}

/** 创建一个带超时的中止控制器，可选合并外部取消信号 */
export function createTimeoutController(timeoutMs: number, external?: AbortSignal): TimeoutController {
  const controller = new AbortController()
  let timedOut = false
  let timer: NodeJS.Timeout | null = null
  let currentMs = timeoutMs

  const arm = (ms: number) => {
    if (timer) clearTimeout(timer)
    currentMs = ms
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
  }

  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }

  arm(timeoutMs)

  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    reset: (ms?: number) => arm(ms ?? currentMs),
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = null
      external?.removeEventListener('abort', onExternalAbort)
    },
  }
}

/**
 * 解析 Retry-After 响应头：可以是秒数，也可以是 HTTP 日期。返回秒数；没有或无法解析时返回 null。
 */
export function parseRetryAfterHeader(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.max(0, Math.round((date - now) / 1000))
}

/**
 * 统一的 HTTP 错误文案：带状态码，服务端给了 Retry-After 时附上 "[retry-after=Ns]"。
 * 渲染层按状态码判断是否重试（retry-policy.ts），按 retry-after 决定等多久。
 */
export function httpErrorMessage(prefix: string, res: { status: number; headers: { get(name: string): string | null } }, body: string): string {
  const retryAfter = parseRetryAfterHeader(res.headers.get('retry-after'))
  const hint = retryAfter !== null ? ` [retry-after=${retryAfter}s]` : ''
  return `${prefix} (${res.status})${hint}: ${body}`
}

/** 超时错误文案（秒数取整），带 "timeout" 关键字供渲染层识别为可重试 */
export function timeoutMessage(ms: number, what = '请求'): string {
  return `${what}超时（timeout）：${Math.round(ms / 1000)} 秒内没有收到响应`
}

/**
 * 在超时内完成整个请求（发请求 + 读完响应体）。
 * run 拿到的 signal 要传给 fetch；超时抛出带 timeout 字样的错误，外部取消照常抛 AbortError。
 */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  options?: { external?: AbortSignal; what?: string },
): Promise<T> {
  const tc = createTimeoutController(timeoutMs, options?.external)
  try {
    return await run(tc.signal)
  } catch (e) {
    if (tc.timedOut) throw new Error(timeoutMessage(timeoutMs, options?.what))
    throw e
  } finally {
    tc.dispose()
  }
}
