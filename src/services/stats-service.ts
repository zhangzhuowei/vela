/**
 * stats-service — LLM 调用统计数据访问服务
 *
 * 封装 BottomPanel ModelsView 中的 IPC 调用。
 */

import { ipc } from './ipc-client'

/** LLM 调用统计 */
export interface LLMStats {
  totalCalls: number
  totalTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
}

/** LLM 调用记录 */
export interface LLMCallRecord {
  id: number
  modelName: string
  purpose: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  success: boolean
  createdAt: string
}

/** 获取 LLM 调用统计 */
export async function getLLMStats(): Promise<LLMStats> {
  return ipc.invoke('db:get-llm-stats')
}

/** 获取最近 LLM 调用记录 */
export async function getLLMHistory(limit = 30): Promise<LLMCallRecord[]> {
  return (await ipc.invoke('db:get-llm-history', limit)) as unknown as LLMCallRecord[]
}

/** 同时加载统计和历史（常用组合） */
export async function loadLLMData(limit = 30): Promise<{ stats: LLMStats; history: LLMCallRecord[] }> {
  const [stats, history] = await Promise.all([
    getLLMStats(),
    getLLMHistory(limit),
  ])
  return { stats, history }
}

/** 一次 LLM 调用的记账信息 */
export interface LLMCallLog {
  modelId: string
  modelName: string
  /** 用途，例如「写稿」「审稿」「蓝图刷新」，用于分辨 token 花在哪一步 */
  purpose: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  success: boolean
  errorMessage?: string
}

/**
 * 记录一次 LLM 调用。
 *
 * 失败的调用同样入账（success=false），否则报错的那些调用在统计里看不见。
 * 记账本身绝不能影响主流程，因此吞掉所有异常。
 */
export async function logLLMCall(call: LLMCallLog): Promise<void> {
  try {
    await ipc.invoke('db:log-llm-call', call as unknown as Record<string, unknown>)
  } catch {
    /* 记账失败不影响生成 */
  }
}
