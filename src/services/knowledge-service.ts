/**
 * knowledge-service — 知识库数据访问服务
 *
 * 封装 KnowledgeOverview 和 KnowledgePanel 中的 IPC 调用，
 * 避免组件直接与 IPC 通信。
 */

import { ipc } from './ipc-client'
import { globalEventBus } from '../shared/event-bus'
import { isBlockedKbImportName, normalizeKbChunks, type KBChunkPreview } from './kb-allocate'

export type { KBChunkPreview }

/** 已导入文档 */
export interface KBDocument {
  id: string
  fileName: string
  importedAt: string
  chunkCount: number
  filePath: string
}

/** 检索结果 */
export interface SearchResult {
  text: string
  score: number
  fileName: string
}

/** 知识库统计 */
export interface KBStatsData {
  documentCount: number
  totalChunks: number
  vectorDimension: number
}

/** 加载文档列表 */
export async function listDocuments(): Promise<KBDocument[]> {
  return ipc.invoke('kb:list-documents')
}

/** 获取知识库统计 */
export async function getStats(): Promise<KBStatsData> {
  return ipc.invoke('kb:stats')
}

/** 同时加载文档列表和统计（常用组合） */
export async function loadKBData(): Promise<{ documents: KBDocument[]; stats: KBStatsData }> {
  const [documents, stats] = await Promise.all([
    ipc.invoke('kb:list-documents'),
    ipc.invoke('kb:stats'),
  ])
  return { documents, stats }
}

/** 获取缺失向量的文档块数量 */
export async function getVectorlessCount(): Promise<number> {
  const result = await ipc.invoke('kb:get-vectorless-count') as { count: number }
  return result.count
}

/** 执行语义检索 */
export async function searchKB(query: string, topK: number): Promise<SearchResult[]> {
  return ipc.invoke('kb:search', query, topK)
}

/** 按文档列出切片（预览） */
export async function listDocumentChunks(docId: string): Promise<KBChunkPreview[]> {
  const rows = await ipc.invoke('kb:list-chunks', docId)
  return normalizeKbChunks(rows)
}

/** 删除知识库文档及其切片 */
export async function removeKbDocument(docId: string): Promise<boolean> {
  const res = await ipc.invoke('kb:remove-document', docId)
  if (res.success) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
  }
  return res.success
}

/** 执行向量回填 */
export async function backfillVectors(): Promise<{ success: boolean; processed: number; failed: number; error?: string }> {
  return ipc.invoke('kb:backfill-vectors') as Promise<{ success: boolean; processed: number; failed: number; error?: string }>
}

export interface KbImportResult {
  cancelled: boolean
  imported: number
  chunks: number
  skipped: string[]
  failed: Array<{ fileName: string; error: string }>
}

function fileBaseName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath
}

/** 弹出多选框，导入 .md / .txt；文件名含「不导入」的跳过 */
export async function importKbFilesFromDialog(): Promise<KbImportResult> {
  const empty: KbImportResult = { cancelled: true, imported: 0, chunks: 0, skipped: [], failed: [] }
  const paths = await ipc.invoke('dialog:select-files')
  if (!paths || paths.length === 0) return empty

  const skipped: string[] = []
  const toImport: string[] = []
  for (const p of paths) {
    if (isBlockedKbImportName(p)) skipped.push(fileBaseName(p))
    else toImport.push(p)
  }

  let imported = 0
  let chunks = 0
  const failed: Array<{ fileName: string; error: string }> = []
  for (const p of toImport) {
    const res = await ipc.invoke('kb:import-document', p)
    if (res.success) {
      imported++
      chunks += res.chunkCount ?? 0
    } else {
      failed.push({ fileName: fileBaseName(p), error: res.error || 'unknown' })
    }
  }

  if (imported > 0) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
  }

  return { cancelled: false, imported, chunks, skipped, failed }
}
