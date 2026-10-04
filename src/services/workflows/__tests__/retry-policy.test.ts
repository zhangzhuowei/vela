import { describe, it, expect } from 'vitest'
import {
  computeRetryDelayMs, isAuthErrorMessage, isRetriableErrorMessage, parseRetryAfterSeconds,
  RETRY_AFTER_CAP_MS, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS,
} from '../retry-policy'

describe('isRetriableErrorMessage', () => {
  it('限流、5xx、超时、网络抖动可重试', () => {
    expect(isRetriableErrorMessage('API 调用失败 (429): rate limit')).toBe(true)
    expect(isRetriableErrorMessage('API 调用失败 (503): overloaded')).toBe(true)
    expect(isRetriableErrorMessage('流式响应超时（timeout）：180 秒内没有收到响应')).toBe(true)
    expect(isRetriableErrorMessage('TypeError: fetch failed（底层原因: ECONNRESET）')).toBe(true)
  })

  it('请求本身有问题的 4xx 不重试', () => {
    expect(isRetriableErrorMessage('API 调用失败 (400): invalid model')).toBe(false)
    expect(isRetriableErrorMessage('API 调用失败 (404): not found')).toBe(false)
  })
})

describe('isAuthErrorMessage', () => {
  it('识别 401 / 403 与常见鉴权文案', () => {
    expect(isAuthErrorMessage('API 调用失败 (401): unauthorized')).toBe(true)
    expect(isAuthErrorMessage('Invalid API key provided')).toBe(true)
    expect(isAuthErrorMessage('API 调用失败 (429): rate limit')).toBe(false)
  })
})

describe('parseRetryAfterSeconds', () => {
  it('从主进程错误文案里取出 retry-after 秒数', () => {
    expect(parseRetryAfterSeconds('API 调用失败 (429) [retry-after=20s]: slow down')).toBe(20)
    expect(parseRetryAfterSeconds('API 调用失败 (429) [retry-after=1.5s]: slow down')).toBe(1.5)
  })

  it('没有 retry-after 时返回 null', () => {
    expect(parseRetryAfterSeconds('API 调用失败 (429): slow down')).toBeNull()
  })
})

describe('computeRetryDelayMs', () => {
  it('没有 Retry-After 时指数退避，并在 50%~100% 之间抖动', () => {
    const msg = 'API 调用失败 (503): busy'
    // random=0 取下限、random=1 取上限
    expect(computeRetryDelayMs(0, msg, () => 0)).toBe(RETRY_BASE_DELAY_MS / 2)
    expect(computeRetryDelayMs(0, msg, () => 1)).toBe(RETRY_BASE_DELAY_MS)
    expect(computeRetryDelayMs(2, msg, () => 1)).toBe(RETRY_BASE_DELAY_MS * 4)
  })

  it('退避时长有上限', () => {
    expect(computeRetryDelayMs(20, 'API 调用失败 (503)', () => 1)).toBe(RETRY_MAX_DELAY_MS)
  })

  it('优先采用服务端 Retry-After，且有上限', () => {
    expect(computeRetryDelayMs(0, 'API 调用失败 (429) [retry-after=20s]', () => 0)).toBe(20_000)
    expect(computeRetryDelayMs(0, 'API 调用失败 (429) [retry-after=99999s]', () => 0)).toBe(RETRY_AFTER_CAP_MS)
  })
})
