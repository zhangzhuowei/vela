import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createTimeoutController, withRequestTimeout, timeoutMessage, parseRetryAfterHeader, httpErrorMessage,
} from '../llm/http'

afterEach(() => {
  vi.useRealTimers()
})

describe('createTimeoutController', () => {
  it('超时后中止，并标记为超时', () => {
    vi.useFakeTimers()
    const tc = createTimeoutController(1000)
    vi.advanceTimersByTime(999)
    expect(tc.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(tc.signal.aborted).toBe(true)
    expect(tc.timedOut).toBe(true)
    tc.dispose()
  })

  it('reset 会重新计时（流式收到数据时续期）', () => {
    vi.useFakeTimers()
    const tc = createTimeoutController(1000)
    vi.advanceTimersByTime(800)
    tc.reset()
    vi.advanceTimersByTime(800)
    expect(tc.signal.aborted).toBe(false)
    vi.advanceTimersByTime(200)
    expect(tc.timedOut).toBe(true)
    tc.dispose()
  })

  it('外部取消会中止，但不算超时', () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const tc = createTimeoutController(1000, external.signal)
    external.abort()
    expect(tc.signal.aborted).toBe(true)
    expect(tc.timedOut).toBe(false)
    tc.dispose()
  })

  it('dispose 之后不再触发超时', () => {
    vi.useFakeTimers()
    const tc = createTimeoutController(1000)
    tc.dispose()
    vi.advanceTimersByTime(5000)
    expect(tc.signal.aborted).toBe(false)
  })
})

describe('withRequestTimeout', () => {
  it('超时抛出带 timeout 字样的错误（渲染层据此判为可重试）', async () => {
    vi.useFakeTimers()
    const pending = withRequestTimeout(1000, (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const assertion = expect(pending).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('正常完成时返回结果', async () => {
    await expect(withRequestTimeout(1000, async () => 42)).resolves.toBe(42)
  })

  it('外部取消照常抛出原始错误，不改写成超时', async () => {
    const external = new AbortController()
    const pending = withRequestTimeout(60_000, (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }), { external: external.signal })
    external.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('timeoutMessage 带秒数与 timeout 关键字', () => {
    expect(timeoutMessage(120_000, '连接')).toContain('120')
    expect(timeoutMessage(120_000)).toMatch(/timeout/)
  })
})

describe('parseRetryAfterHeader', () => {
  it('支持秒数', () => {
    expect(parseRetryAfterHeader('30')).toBe(30)
  })

  it('支持 HTTP 日期', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfterHeader('Thu, 01 Jan 2026 00:00:45 GMT', now)).toBe(45)
  })

  it('缺失或无法解析时返回 null', () => {
    expect(parseRetryAfterHeader(null)).toBeNull()
    expect(parseRetryAfterHeader('soon')).toBeNull()
  })
})

describe('httpErrorMessage', () => {
  const res = (status: number, retryAfter?: string) => ({
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
  })

  it('带状态码；有 Retry-After 时附上 retry-after 提示', () => {
    expect(httpErrorMessage('API 调用失败', res(429, '12'), 'slow down')).toBe('API 调用失败 (429) [retry-after=12s]: slow down')
    expect(httpErrorMessage('API 调用失败', res(500), 'oops')).toBe('API 调用失败 (500): oops')
  })
})
