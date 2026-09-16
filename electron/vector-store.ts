/**
 * Vela 向量数据库封装 — 基于 LanceDB
 *
 * 提供本地嵌入式向量数据库能力，替代旧的 vectors.json 方案。
 * 支持两种检索模式：
 * - FTS-only（BM25 全文检索，零配置默认可用）
 * - 混合检索（FTS + 向量近邻，需要 Embedding 模型）
 *
 * 存储位置：{projectPath}/.vela/lancedb/
 */
import * as lancedb from '@lancedb/lancedb'
import { MatchQuery } from '@lancedb/lancedb'
import { Field, FixedSizeList as ArrowFixedSizeList, Float32, Int32, Utf8, Schema as ArrowSchema } from 'apache-arrow'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ===== 类型定义 =====

/** 写入 LanceDB 的文本块记录 */
export interface ChunkRecord {
  [key: string]: unknown
  id: string
  docId: string
  fileName: string
  /** 章节号（可选，用于范围检索） */
  chapterNumber?: number
  /** 章节标题（可选，用于展示） */
  chapterTitle?: string
  text: string
  vector?: number[]
  chunkIndex: number
  totalChunks: number
  importedAt: string
}

/** 文档元信息（聚合查询结果） */
export interface DocumentInfo {
  [key: string]: unknown
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
export interface KBStats {
  documentCount: number
  totalChunks: number
  vectorDimension: number
  hasVectors: boolean
}

// ===== 常量 =====

const TABLE_NAME = 'chunks'
const DOCS_TABLE_NAME = 'documents'

/**
 * FTS 分词配置：双字组 ngram。
 *
 * Tantivy 默认 simple 分词器按空白/标点切词，中文整句会被当成单个 token，
 * 索引形同虚设——这也是旧实现只能退化为逐字 LIKE 全表扫描的原因。
 * 双字组对中文给出正确的 BM25 召回与排序（实测「金丹」不会误中「金色的丹药」，
 * 而逐字 LIKE 会）；对英文按字符二元组同样可用。
 * 不存 token 位置（不需要短语查询），索引更小、构建更快。
 */
const FTS_INDEX_CONFIG = {
  baseTokenizer: 'ngram' as const,
  ngramMinLength: 2,
  ngramMaxLength: 2,
  prefixOnly: false,
  withPosition: false,
  lowercase: true,
}

/** FTS 索引方案版本：分词配置变更时 +1，存量库在下次检索/导入时自动按新方案重建 */
const FTS_INDEX_VERSION = 2

/** 已确认 FTS 索引为当前方案的项目（进程内缓存，避免每次检索都读盘） */
const ftsEnsured = new Set<string>()

function ftsMarkerPath(projectPath: string): string {
  return path.join(projectPath, '.vela', 'fts-index-version')
}

/** 标记该项目的 FTS 索引已是当前方案（导入/重建后调用） */
function markFtsCurrent(projectPath: string): void {
  try {
    fs.writeFileSync(ftsMarkerPath(projectPath), String(FTS_INDEX_VERSION))
  } catch { /* 标记失败只影响下次多一遍重建检查 */ }
  ftsEnsured.add(projectPath)
}

/**
 * 存量库迁移：FTS 索引方案落后时按当前分词配置重建（replace 语义）。
 * 幂等，检索与导入路径都会经过；版本一致时仅一次 Set 查询的开销。
 */
async function ensureFtsIndex(db: lancedb.Connection, projectPath: string): Promise<void> {
  if (ftsEnsured.has(projectPath)) return
  try {
    const marker = ftsMarkerPath(projectPath)
    const version = fs.existsSync(marker) ? parseInt(fs.readFileSync(marker, 'utf-8').trim(), 10) : 0
    if (version === FTS_INDEX_VERSION) {
      ftsEnsured.add(projectPath)
      return
    }
  } catch { /* 标记读取失败按需要重建处理 */ }

  const tableNames = await db.tableNames()
  if (tableNames.includes(TABLE_NAME)) {
    const table = await db.openTable(TABLE_NAME)
    await table.createIndex('text', { config: lancedb.Index.fts(FTS_INDEX_CONFIG) })
    console.log(`[Vela VectorStore] FTS 索引已按 v${FTS_INDEX_VERSION} 方案（ngram 双字组）重建`)
  }
  markFtsCurrent(projectPath)
}

// ===== 连接池（按项目路径缓存） =====

const connectionPool = new Map<string, lancedb.Connection>()

/** 获取 LanceDB 连接（惰性创建） */
export async function getConnection(projectPath: string): Promise<lancedb.Connection> {
  const dbPath = path.join(projectPath, '.vela', 'lancedb')
  
  const cached = connectionPool.get(dbPath)
  if (cached) return cached

  // 确保目录存在
  fs.mkdirSync(dbPath, { recursive: true })

  const db = await lancedb.connect(dbPath)
  connectionPool.set(dbPath, db)
  return db
}

/**
 * 关闭指定项目的连接。
 * 必须调用底层 close() 释放文件句柄——只从池里删除引用的话，
 * Windows 上旧项目的 .vela/lancedb 目录会一直被句柄锁住（无法删除/备份/同步），
 * 且多项目切换后句柄随之堆积。
 */
export function closeConnection(projectPath: string): void {
  const dbPath = path.join(projectPath, '.vela', 'lancedb')
  const conn = connectionPool.get(dbPath)
  if (conn) {
    try { conn.close() } catch { /* close 幂等，二次关闭等异常忽略 */ }
    connectionPool.delete(dbPath)
  }
}

/** 关闭池中全部连接（切换项目 / 应用退出时调用） */
export function closeAllConnections(): void {
  for (const [dbPath, conn] of connectionPool) {
    try { conn.close() } catch { /* 忽略 */ }
    connectionPool.delete(dbPath)
  }
}

// ===== 向量维度工具 =====
// 向量维度不再写死，而是按 Embedding 模型实际输出动态确定，
// 以兼容任意 provider（智谱 embedding-3=2048、bge-m3=1024、bce=768、OpenAI=1536/3072…）。

/** 从一批向量中取首个非空向量的维度；全为空则返回 null */
function firstVectorDim(vectors?: Array<number[] | undefined>): number | null {
  if (!vectors) return null
  for (const v of vectors) {
    if (v && v.length > 0) return v.length
  }
  return null
}

/** 读取已存在表 vector 列的维度（FixedSizeList 的 listSize）；无向量列返回 null */
function schemaVectorDim(schema: { fields: Array<{ name: string; type: unknown }> }): number | null {
  const vf = schema.fields.find((f) => f.name === 'vector')
  if (!vf) return null
  const t = vf.type as { listSize?: number }
  return typeof t.listSize === 'number' ? t.listSize : null
}

/** 按维度构建 chunks 表 schema；dim 为 null/0 时不含 vector 列（FTS-only 模式） */
function buildChunkSchema(dim: number | null): ArrowSchema {
  const fields: Field[] = [
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
  ]
  if (dim && dim > 0) {
    fields.push(new Field('vector', new ArrowFixedSizeList(dim, new Field('item', new Float32())), true))
  }
  fields.push(
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
  )
  return new ArrowSchema(fields)
}


// ===== 核心操作 =====

/**
 * 写入文档块到 LanceDB
 * 支持带向量（混合模式）和不带向量（FTS-only 模式）
 */
export async function addChunks(
  projectPath: string,
  docId: string,
  fileName: string,
  chunks: string[],
  vectors?: number[][],
  filePath?: string,
  metadata?: { chapterNumber?: number; chapterTitle?: string },
): Promise<{ success: boolean; chunkCount: number; error?: string }> {
  try {
    const db = await getConnection(projectPath)
    const now = new Date().toISOString()

    // 构建记录
    const records: ChunkRecord[] = chunks.map((text, i) => {
      const record: ChunkRecord = {
        id: randomUUID(),
        docId,
        fileName,
        text,
        chunkIndex: i,
        totalChunks: chunks.length,
        importedAt: now,
        chapterNumber: metadata?.chapterNumber,
        chapterTitle: metadata?.chapterTitle,
      }
      // 如果有向量，附加到记录上
      if (vectors && vectors[i] && vectors[i].length > 0) {
        record.vector = vectors[i]
      }
      return record
    })

    // 写入 chunks 表 —— 向量维度按本批实际输出确定（兼容任意 Embedding 模型）
    const tableNames = await db.tableNames()
    const incomingDim = firstVectorDim(vectors)

    if (tableNames.includes(TABLE_NAME)) {
      const table = await db.openTable(TABLE_NAME)
      const existingSchema = await table.schema()
      const existingFieldNames = existingSchema.fields.map(f => f.name)
      const existingDim = schemaVectorDim(existingSchema)
      // 检查旧表 schema 是否包含所有业务字段。
      // vector 列单独判断：纯 FTS 模式（未配 Embedding）建表时刻意不含 vector 列，
      // 若把它计入必填字段，每次导入都会误判"缺列"而走全表重建——
      // 读全表→drop→重建的开销随知识库线性增长，主进程被同步拷贝卡死
      const requiredFields = ['id', 'docId', 'fileName', 'text', 'chunkIndex', 'totalChunks', 'importedAt', 'chapterNumber', 'chapterTitle']
      const hasBusinessFields = requiredFields.every(f => existingFieldNames.includes(f))
      // 本批带向量但旧表无 vector 列（如刚配好 Embedding）：需重建一次补列
      const needVectorColumn = incomingDim != null && !existingFieldNames.includes('vector')
      // 维度冲突：更换了 Embedding 模型，新旧向量维度不同（FixedSizeList 无法混存）
      const dimConflict = incomingDim != null && existingDim != null && incomingDim !== existingDim

      if (hasBusinessFields && !needVectorColumn && !dimConflict) {
        await table.add(records)
      } else if (dimConflict) {
        // 换模型：旧向量与新模型不兼容，重建表、丢弃旧向量（保留文本，供按新模型重新回填）
        const allRows = await table.query().toArray()
        const cleanRows = allRows.map((r: Record<string, unknown>) => {
          const cleaned: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(r)) {
            if (k === 'vector') continue // 丢弃旧维度向量
            cleaned[k] = v
          }
          return cleaned
        })
        await db.dropTable(TABLE_NAME)
        await db.createTable(TABLE_NAME, [...cleanRows, ...records], { schema: buildChunkSchema(incomingDim) })
        console.log(`[Vela VectorStore] Embedding 维度变化(${existingDim}→${incomingDim})，已重建向量表，旧向量待重新回填`)
      } else {
        // 旧表缺字段，重建补齐；沿用本批/既有维度
        // 先把 Arrow Vector 对象转成纯 number[]，避免 isValid 等元数据字段干扰 schema 校验
        const rebuildDim = incomingDim ?? existingDim
        const allRows = await table.query().toArray()
        const cleanRows = allRows.map((r: Record<string, unknown>) => {
          const cleaned: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(r)) {
            if (k === 'vector' && v) {
              // Arrow Vector → 纯数组
              const vec = v as { toArray?: () => number[] }
              cleaned[k] = vec.toArray ? vec.toArray() : v
            } else {
              cleaned[k] = v
            }
          }
          return cleaned
        })
        await db.dropTable(TABLE_NAME)
        await db.createTable(TABLE_NAME, [...cleanRows, ...records], { schema: buildChunkSchema(rebuildDim) })
      }
    } else {
      // 首次创建：有向量则按其维度建 vector 列；纯 FTS（无向量）则先不建 vector 列，
      // 待配置 Embedding 后回填时再按真实维度重建，避免锁死错误维度。
      await db.createTable(TABLE_NAME, records, { schema: buildChunkSchema(incomingDim) })
    }

    // 写入/更新 documents 表
    const docInfo: DocumentInfo = {
      id: docId,
      fileName,
      importedAt: now,
      chunkCount: chunks.length,
      filePath: filePath || '',
    }

    if (tableNames.includes(DOCS_TABLE_NAME)) {
      const docsTable = await db.openTable(DOCS_TABLE_NAME)
      // 先删除同名文档（幂等性），再添加新的
      try {
        await docsTable.delete(`fileName = '${fileName.replace(/'/g, "''")}'`)
      } catch { /* 表可能为空或无匹配 */ }
      await docsTable.add([docInfo])
    } else {
      await db.createTable(DOCS_TABLE_NAME, [docInfo])
    }

    // 刷新 FTS 索引（ngram 中文分词；replace 语义覆盖旧索引，保证新导入的块可检索）
    try {
      const chunksTable = await db.openTable(TABLE_NAME)
      await chunksTable.createIndex('text', {
        config: lancedb.Index.fts(FTS_INDEX_CONFIG),
      })
      markFtsCurrent(projectPath)
    } catch (e) {
      console.warn('[Vela VectorStore] FTS 索引创建失败（检索将走 LIKE 兜底）:', e)
    }

    return { success: true, chunkCount: chunks.length }
  } catch (error) {
    console.error('[Vela VectorStore] 写入失败:', error)
    return { success: false, chunkCount: 0, error: String(error) }
  }
}

/**
 * 删除文档及其所有块
 */
export async function removeDocument(
  projectPath: string,
  docId: string,
): Promise<boolean> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()

    const escaped = String(docId).replace(/'/g, "''")

    if (tableNames.includes(TABLE_NAME)) {
      const table = await db.openTable(TABLE_NAME)
      await table.delete(`docId = '${escaped}'`)
    }

    if (tableNames.includes(DOCS_TABLE_NAME)) {
      const docsTable = await db.openTable(DOCS_TABLE_NAME)
      await docsTable.delete(`id = '${escaped}'`)
    }

    return true
  } catch (error) {
    console.error('[Vela VectorStore] 删除失败:', error)
    return false
  }
}

/**
 * 统一检索入口 — 自动选择 FTS / 混合模式
 *
 * @param queryText 搜索关键词/语句
 * @param queryVector 查询向量（可选，有值时启用混合检索）
 * @param topK 返回前 K 个结果
 */
export async function search(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
): Promise<SearchResult[]> {
  return searchWithScope(projectPath, queryText, queryVector, topK)
}

/** 内部检索结果（带行 id，供两路结果融合去重） */
interface RankedResult extends SearchResult {
  id: string
}

/** FTS（BM25 · ngram 双字组）检索一路；分数按本组最大值归一化 */
async function ftsSearch(
  table: lancedb.Table,
  query: string,
  topK: number,
  scopeFilter?: string,
): Promise<RankedResult[]> {
  let q = table.query().fullTextSearch(new MatchQuery(query, 'text')).limit(topK)
  if (scopeFilter) q = q.where(scopeFilter)
  const rows = await q.toArray()
  const maxScore = rows.reduce((m: number, r: { _score?: number }) => Math.max(m, r._score ?? 0), 0) || 1
  return rows.map((r: { id: string; text: string; fileName: string; _score?: number }) => ({
    id: r.id,
    text: r.text,
    fileName: r.fileName,
    score: (r._score ?? 0) / maxScore,
  }))
}

/** 向量近邻检索一路 */
async function vectorSearch(
  table: lancedb.Table,
  queryVector: number[],
  topK: number,
  scopeFilter?: string,
): Promise<RankedResult[]> {
  let query = table.search(queryVector).limit(topK)
  if (scopeFilter) query = query.where(scopeFilter)
  const rows = await query.toArray()
  return rows.map((r: { id: string; text: string; fileName: string; _distance?: number }) => ({
    id: r.id,
    text: r.text,
    fileName: r.fileName,
    score: r._distance != null ? 1 / (1 + r._distance) : 0.5,
  }))
}

/** RRF（倒数排名融合）合并两路排序结果，最终分数按最大值归一化 */
function fuseByRrf(listA: RankedResult[], listB: RankedResult[], topK: number): SearchResult[] {
  const K = 60
  const fused = new Map<string, { result: RankedResult; score: number }>()
  for (const list of [listA, listB]) {
    list.forEach((r, rank) => {
      const gain = 1 / (K + rank + 1)
      const existing = fused.get(r.id)
      if (existing) existing.score += gain
      else fused.set(r.id, { result: r, score: gain })
    })
  }
  const sorted = Array.from(fused.values()).sort((a, b) => b.score - a.score).slice(0, topK)
  const maxScore = sorted[0]?.score || 1
  return sorted.map(({ result, score }) => ({
    text: result.text,
    fileName: result.fileName,
    score: score / maxScore,
  }))
}

/** 旧逐字 LIKE 兜底（仅当 FTS 不可用：查询短于 2 字或索引异常） */
async function likeFallbackSearch(
  table: lancedb.Table,
  queryText: string,
  topK: number,
  scopeFilter?: string,
): Promise<SearchResult[]> {
  try {
    const escapedQuery = queryText.replace(/'/g, "''")
    const likePattern = `%${escapedQuery.split('').join('%')}%`
    let q = table.query().filter(`text LIKE '${likePattern}'`).limit(topK)
    if (scopeFilter) q = q.where(scopeFilter)
    const results = await q.toArray()
    return results.map((r: { text: string; fileName: string }) => ({
      text: r.text,
      score: 0.5, // 无打分
      fileName: r.fileName,
    }))
  } catch (e) {
    console.warn('[Vela VectorStore] LIKE 兜底检索失败:', e)
    return []
  }
}

/**
 * 支持章节范围限定的检索入口
 *
 * 检索策略：
 *   - FTS（BM25 · ngram 双字组）与向量近邻各取一路，两路都有结果时用 RRF 融合排序
 *   - 仅一路可用时直接返回该路（分数分别为归一化 BM25 / 1/(1+距离)）
 *   - FTS 不可用（查询短于 2 字构不成双字组、或索引异常）时退回旧的逐字 LIKE 兜底；
 *     FTS 正常返回空则如实返回空——逐字 LIKE 的散字命中是垃圾参考，宁缺毋滥
 *
 * @param queryText 搜索关键词/语句
 * @param queryVector 查询向量（可选，有值时启用混合检索）
 * @param topK 返回前 K 个结果
 * @param chapterScope 可选，限定检索的章节范围 [fromChapter, toChapter]
 */
export async function searchWithScope(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
  chapterScope?: [number, number],
): Promise<SearchResult[]> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return []

    const table = await db.openTable(TABLE_NAME)

    // 构建范围过滤条件
    let scopeFilter: string | undefined
    if (chapterScope) {
      const [from, to] = chapterScope
      scopeFilter = `chapterNumber >= ${from} AND chapterNumber <= ${to}`
    }

    // 存量库迁移：确保 FTS 索引已按当前分词方案重建
    try {
      await ensureFtsIndex(db, projectPath)
    } catch (e) {
      console.warn('[Vela VectorStore] FTS 索引迁移失败，本次检索走兜底:', e)
    }

    const trimmed = (queryText || '').trim()

    // FTS 一路：null 表示"这一路不可用"（区别于合法的空结果）
    let ftsResults: RankedResult[] | null = null
    if (trimmed.length >= 2) {
      try {
        ftsResults = await ftsSearch(table, trimmed, topK, scopeFilter)
      } catch (e) {
        console.warn('[Vela VectorStore] FTS 检索失败，回退 LIKE:', e)
      }
    }

    // 向量一路
    let vecResults: RankedResult[] = []
    if (queryVector && queryVector.length > 0) {
      try {
        vecResults = await vectorSearch(table, queryVector, topK, scopeFilter)
      } catch { /* 向量检索失败，走 FTS / 兜底 */ }
    }

    if (ftsResults && ftsResults.length > 0 && vecResults.length > 0) {
      return fuseByRrf(ftsResults, vecResults, topK)
    }
    if (vecResults.length > 0) {
      return vecResults.slice(0, topK).map(({ text, fileName, score }) => ({ text, fileName, score }))
    }
    if (ftsResults) {
      // FTS 可用：即使为空也如实返回，不再用逐字 LIKE 的散字命中充数
      return ftsResults.slice(0, topK).map(({ text, fileName, score }) => ({ text, fileName, score }))
    }

    return likeFallbackSearch(table, trimmed, topK, scopeFilter)
  } catch (error) {
    console.error('[Vela VectorStore] 检索失败:', error)
    return []
  }
}

/** 按文档列出切片（不含向量），供预览 */
export async function listChunksByDocId(
  projectPath: string,
  docId: string,
): Promise<Array<{ id: string; chunkIndex: number; totalChunks: number; text: string; fileName: string }>> {
  if (!docId) return []
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return []

    const table = await db.openTable(TABLE_NAME)
    const escaped = docId.replace(/'/g, "''")
    const rows = await table
      .query()
      .where(`docId = '${escaped}'`)
      .select(['id', 'chunkIndex', 'totalChunks', 'text', 'fileName'])
      .toArray()

    return rows
      .map((r: { id: string; chunkIndex: number; totalChunks: number; text: string; fileName: string }) => ({
        id: String(r.id),
        chunkIndex: Number(r.chunkIndex),
        totalChunks: Number(r.totalChunks),
        text: String(r.text ?? ''),
        fileName: String(r.fileName ?? ''),
      }))
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
  } catch (error) {
    console.error('[Vela VectorStore] 按文档列切片失败:', error)
    return []
  }
}

/**
 * 列出所有已导入文档
 */
export async function listDocuments(
  projectPath: string,
): Promise<DocumentInfo[]> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(DOCS_TABLE_NAME)) return []

    const docsTable = await db.openTable(DOCS_TABLE_NAME)
    const rows = await docsTable.query().toArray()
    return rows.map((r: { id: string; fileName: string; importedAt: string; chunkCount: number; filePath?: string }) => ({
      id: r.id,
      fileName: r.fileName,
      importedAt: r.importedAt,
      chunkCount: r.chunkCount,
      filePath: r.filePath || '',
    }))
  } catch {
    return []
  }
}

/**
 * 获取知识库统计信息
 */
export async function getStats(projectPath: string): Promise<KBStats> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()

    if (!tableNames.includes(TABLE_NAME)) {
      return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
    }

    const docs = tableNames.includes(DOCS_TABLE_NAME)
      ? await (await db.openTable(DOCS_TABLE_NAME)).countRows()
      : 0

    const table = await db.openTable(TABLE_NAME)
    const totalChunks = await table.countRows()

    // 检测是否有向量列（通过 schema 而非运行时值判断）
    let hasVectors = false
    let vectorDimension = 0
    try {
      const schema = await table.schema()
      const dim = schemaVectorDim(schema)
      if (dim != null) {
        hasVectors = true
        vectorDimension = dim // 实际向量维度（由 Embedding 模型输出决定）
      }
    } catch { /* 忽略 */ }

    return {
      documentCount: docs,
      totalChunks,
      vectorDimension,
      hasVectors,
    }
  } catch {
    return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
  }
}

/**
 * 获取没有向量的文本块数量（用于回填检测）
 */
export async function getChunksWithoutVectors(
  projectPath: string,
): Promise<{ count: number }> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return { count: 0 }

    const table = await db.openTable(TABLE_NAME)
    const schema = await table.schema()
    const hasVectorCol = schema.fields.some(f => f.name === 'vector')

    if (!hasVectorCol) {
      const total = await table.countRows()
      return { count: total }
    }

    // 有 vector 列的情况下，统计 vector 为 null 的记录
    const all = await table.query().select(['id', 'vector']).toArray()
    const missing = all.filter((r: { id: string; vector?: unknown }) => {
      if (!r.vector) return true
      const vec = r.vector as { length?: number; toArray?: () => unknown[] }
      if (typeof vec.toArray === 'function') {
        return vec.toArray().length === 0
      }
      return (vec.length ?? -1) === 0
    })
    return { count: missing.length }
  } catch (e) {
    console.error('[Vela KB] getChunksWithoutVectors error:', e)
    return { count: 0 }
  }
}

/**
 * 为缺少向量的块批量回填向量
 * 返回无向量的块列表（id + text），供调用方批量生成向量后更新
 */
export async function getChunksForBackfill(
  projectPath: string,
  batchSize: number = 50,
): Promise<Array<{ id: string; text: string }>> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return []

    const table = await db.openTable(TABLE_NAME)
    const schema = await table.schema()
    const hasVectorCol = schema.fields.some(f => f.name === 'vector')

    let missing = []

    if (!hasVectorCol) {
      const all = await table.query().select(['id', 'text']).toArray()
      missing = all // 全部没有向量
    } else {
      const all = await table.query().select(['id', 'text', 'vector']).toArray()
      missing = all.filter((r: { id: string; text: string; vector?: unknown }) => {
        if (!r.vector) return true
        const vec = r.vector as { length?: number; toArray?: () => number[] }
        const len = vec.toArray ? vec.toArray().length : (vec.length ?? 0)
        return len === 0
      })
    }
    
    // 只返回一批
    return missing.slice(0, batchSize).map((r: { id: string; text: string; vector?: number[] }) => ({
      id: r.id,
      text: r.text,
    }))
  } catch {
    return []
  }
}

/**
 * 更新指定块的向量（回填用）
 */
export async function updateChunkVectors(
  projectPath: string,
  updates: Array<{ id: string; vector: number[] }>,
): Promise<{ success: boolean; count: number }> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return { success: false, count: 0 }

    const table = await db.openTable(TABLE_NAME)
    const existingSchema = await table.schema()
    const hasVectorCol = existingSchema.fields.some(f => f.name === 'vector')
    const existingDim = schemaVectorDim(existingSchema)
    const updateDim = firstVectorDim(updates.map(u => u.vector))

    // 小批量且维度一致（或无法判定）时走逐行 update；
    // 大批量（全库回填可达数千条）逐行 update 是数千次串行小事务，
    // 一次性重建反而更快，直接走下方覆写路径
    const PER_ROW_UPDATE_LIMIT = 200
    if (hasVectorCol && updates.length <= PER_ROW_UPDATE_LIMIT && (existingDim == null || updateDim == null || existingDim === updateDim)) {
      for (const update of updates) {
        try {
          await table.update({
            where: `id = '${update.id}'`,
            values: { vector: update.vector },
          })
        } catch (e) {
          console.warn(`[Vela VectorStore] 更新块 ${update.id} 向量失败:`, e)
        }
      }
      return { success: true, count: updates.length }
    }

    // 无 vector 列，或维度变化 → 覆写全表重建（按 updateDim 建 vector 列）
    const rebuildDim = updateDim ?? existingDim
    const updateMap = new Map(updates.map(u => [u.id, u.vector]))
    const allRecords = await table.query().toArray()
    const newData = allRecords.map((r: Record<string, unknown>) => {
      const row: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) {
        if (k === 'vector') continue // 稍后按维度决定是否保留
        row[k] = v
      }
      const up = updateMap.get(r.id as string)
      if (up && up.length > 0) {
        row.vector = up
      } else if (r.vector) {
        // 保留既有向量，但仅当维度与目标一致（否则丢弃，等待后续重新回填）
        const vec = r.vector as { toArray?: () => number[] }
        const arr = vec.toArray ? vec.toArray() : (r.vector as number[])
        if (Array.isArray(arr) && arr.length === rebuildDim) row.vector = arr
      }
      return row
    })

    await db.dropTable(TABLE_NAME)
    await db.createTable(TABLE_NAME, newData, { schema: buildChunkSchema(rebuildDim) })

    // 重建 FTS 索引（ngram 中文分词）
    try {
      const newTable = await db.openTable(TABLE_NAME)
      await newTable.createIndex('text', { config: lancedb.Index.fts(FTS_INDEX_CONFIG) })
      markFtsCurrent(projectPath)
    } catch (e) {
      console.warn('[Vela VectorStore] 回填覆写后 FTS 重建失败:', e)
    }

    return { success: true, count: updates.length }
  } catch (error) {
    console.error('[Vela VectorStore] 批量更新向量失败:', error)
    return { success: false, count: 0 }
  }
}

/**
 * 从旧 vectors.json 迁移数据到 LanceDB
 */
export async function migrateFromJSON(
  projectPath: string,
): Promise<{ success: boolean; migrated: number; error?: string }> {
  const jsonPath = path.join(projectPath, '.vela', 'vectors.json')
  
  if (!fs.existsSync(jsonPath)) {
    return { success: true, migrated: 0 }
  }

  try {
    console.log('[Vela VectorStore] 检测到旧 vectors.json，开始迁移...')
    const raw = fs.readFileSync(jsonPath, 'utf-8')
    const store = JSON.parse(raw) as {
      documents: Array<{ id: string; fileName: string; importedAt: string; chunkCount: number; filePath: string }>
      entries: Array<{ id: string; docId: string; text: string; vector: number[]; meta: { fileName: string; chunkIndex: number; totalChunks: number } }>
    }

    if (!store.entries || store.entries.length === 0) {
      // 空知识库，无需迁移
      fs.renameSync(jsonPath, jsonPath + '.migrated')
      return { success: true, migrated: 0 }
    }

    // 按文档分组写入
    const docMap = new Map<string, typeof store.entries>()
    for (const entry of store.entries) {
      const arr = docMap.get(entry.docId) || []
      arr.push(entry)
      docMap.set(entry.docId, arr)
    }

    let migrated = 0
    for (const [docId, entries] of docMap) {
      const docInfo = store.documents.find(d => d.id === docId)
      const fileName = docInfo?.fileName || entries[0]?.meta?.fileName || 'unknown'
      
      const chunks = entries.map(e => e.text)
      const vectors = entries.map(e => e.vector).filter(v => v && v.length > 0)
      
      await addChunks(
        projectPath,
        docId,
        fileName,
        chunks,
        vectors.length === chunks.length ? vectors : undefined,
        docInfo?.filePath,
      )
      migrated += entries.length
    }

    // 迁移完成，重命名旧文件
    fs.renameSync(jsonPath, jsonPath + '.migrated')
    console.log(`[Vela VectorStore] 迁移完成：${migrated} 个块已写入 LanceDB`)
    
    return { success: true, migrated }
  } catch (error) {
    console.error('[Vela VectorStore] 迁移失败:', error)
    return { success: false, migrated: 0, error: String(error) }
  }
}
