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

/** 关闭指定项目的连接 */
export function closeConnection(projectPath: string): void {
  const dbPath = path.join(projectPath, '.vela', 'lancedb')
  connectionPool.delete(dbPath)
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
      // 检查旧表 schema 是否包含所有必要字段
      const requiredFields = ['id', 'docId', 'fileName', 'text', 'chunkIndex', 'totalChunks', 'importedAt', 'chapterNumber', 'chapterTitle', 'vector']
      const hasAllFields = requiredFields.every(f => existingFieldNames.includes(f))
      // 维度冲突：更换了 Embedding 模型，新旧向量维度不同（FixedSizeList 无法混存）
      const dimConflict = incomingDim != null && existingDim != null && incomingDim !== existingDim

      if (hasAllFields && !dimConflict) {
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

    // 尝试创建 FTS 索引（如果尚不存在）
    try {
      const chunksTable = await db.openTable(TABLE_NAME)
      await chunksTable.createIndex('text', {
        config: lancedb.Index.fts(),
      })
    } catch {
      // FTS 索引可能已存在，忽略错误
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

    if (tableNames.includes(TABLE_NAME)) {
      const table = await db.openTable(TABLE_NAME)
      await table.delete(`docId = '${docId}'`)
    }

    if (tableNames.includes(DOCS_TABLE_NAME)) {
      const docsTable = await db.openTable(DOCS_TABLE_NAME)
      await docsTable.delete(`id = '${docId}'`)
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

/**
 * 支持章节范围限定的检索入口
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

    // 如果有查询向量，先尝试混合检索
    if (queryVector && queryVector.length > 0) {
      try {
        let query = table.search(queryVector).limit(topK)
        if (scopeFilter) {
          query = query.where(scopeFilter)
        }
        const results = await query.toArray()

        if (results.length > 0) {
          return results.map((r: { text: string; _distance?: number; fileName: string }) => ({
            text: r.text,
            score: r._distance != null ? 1 / (1 + r._distance) : 0.5,
            fileName: r.fileName,
          }))
        }
      } catch {
        // 向量检索失败，降级到 FTS
      }
    }

    // FTS 检索 (Tantivy 不支持中文分词，改为 DataFusion LIKE 模糊匹配)
    try {
      const escapedQuery = queryText.replace(/'/g, "''")
      // 将 "搜索" 转换为 "%搜%索%" 进行容错匹配
      const likePattern = `%${escapedQuery.split('').join('%')}%`

      let q = table.query().filter(`text LIKE '${likePattern}'`).limit(topK)
      if (scopeFilter) {
        q = q.where(scopeFilter)
      }
      const results = await q.toArray()

      return results.map((r: { text: string; fileName: string }) => ({
        text: r.text,
        score: 0.5, // 普通匹配无打分
        fileName: r.fileName,
      }))
    } catch (e) {
      console.warn('[Vela VectorStore] 纯文本检索失败:', e)
      return []
    }
  } catch (error) {
    console.error('[Vela VectorStore] 检索失败:', error)
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

    // 维度一致（或无法判定）时走高效的逐行 update
    if (hasVectorCol && (existingDim == null || updateDim == null || existingDim === updateDim)) {
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

    // 重建 FTS 索引
    try {
      const newTable = await db.openTable(TABLE_NAME)
      await newTable.createIndex('text', { config: lancedb.Index.fts() })
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
