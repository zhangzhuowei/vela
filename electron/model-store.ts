/**
 * 模型配置存储（~/.vela/models.json）
 *
 * - API Key 经 Electron safeStorage 加密后存为 apiKeyEnc（Windows 上由 DPAPI 保护的密钥加密），文件里不留明文；
 *   系统不支持加密时（例如部分 Linux 桌面没有密钥环）退回明文保存并告警。
 * - 旧版的明文 Key 在第一次读取时自动迁移为加密存储，并同步覆盖 .bak 里的明文副本。
 * - 渲染进程只拿到打码后的 Key（••••••••+末 4 位）。保存 / 测试连接 / 文生图时收到打码值，表示「沿用已保存的 Key」；
 *   但只有接口地址未改时才沿用，否则拿到 velaAPI 的页面就能让主进程把已保存的 Key 发往任意地址。
 *
 * 注意：加密密钥与当前系统账户（及应用数据目录）绑定。把 ~/.vela 拷到另一台电脑或另一个账户后 Key 无法解密，
 * 界面上会显示为未填写，重新填写即可。
 */
import { safeStorage } from 'electron'
import fs from 'node:fs'
import type { ModelProfile } from '../src/shared/ipc-channels'
import { MODELS_CONFIG_PATH, readJsonFile, writeJsonFile } from './utils/config-utils'

export interface KeyCipher {
  isAvailable(): boolean
  /** 返回可写入 JSON 的字符串（base64） */
  encrypt(plain: string): string
  decrypt(encoded: string): string
}

/** models.json 中的单条记录：apiKey 只在无法加密时保存明文（或是尚未迁移的旧数据） */
type StoredModel = Omit<ModelProfile, 'apiKey'> & { apiKey?: string; apiKeyEnc?: string }

const MASK_CHAR = '•'
const MASK = MASK_CHAR.repeat(8)

/** 打码：较长的 Key 保留末 4 位便于辨认，短 Key 全部隐藏 */
export function maskApiKey(key: string): string {
  if (!key) return ''
  return key.length > 8 ? `${MASK}${key.slice(-4)}` : MASK
}

/** 含打码字符即视为「沿用已保存的 Key」（用户在打码值上做了局部修改也按沿用处理，真实 Key 不会含该字符） */
export function isMaskedApiKey(value: unknown): value is string {
  return typeof value === 'string' && value.includes(MASK_CHAR)
}

function normalizeBaseUrl(url: unknown): string {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '').toLowerCase() : ''
}

/** 需要用户处理的 Key 问题（错误信息可直接展示） */
export class ModelKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelKeyError'
  }
}

export function createModelStore(deps: { filePath: string; cipher: KeyCipher }) {
  const { filePath, cipher } = deps

  const readStored = (): StoredModel[] => {
    const list = readJsonFile<StoredModel[]>(filePath, [])
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : []
  }

  const decryptKey = (m: StoredModel): string => {
    if (m.apiKeyEnc) {
      try {
        return cipher.decrypt(m.apiKeyEnc)
      } catch {
        console.warn(`[Vela Models] 模型「${m.name || m.id}」的 API Key 无法解密（系统账户或应用数据目录可能已变更），需要重新填写`)
        return ''
      }
    }
    return m.apiKey ?? ''
  }

  const encodeKey = (key: string): Pick<StoredModel, 'apiKey' | 'apiKeyEnc'> => {
    if (!key) return { apiKey: '' }
    if (cipher.isAvailable()) return { apiKey: '', apiKeyEnc: cipher.encrypt(key) }
    console.warn('[Vela Models] 系统不支持安全存储，API Key 只能以明文保存在 models.json')
    return { apiKey: key }
  }

  /** 组装写盘记录：去掉渲染进程可能夹带的 apiKey / apiKeyEnc，只按 key 重新编码 */
  const toStored = (profile: StoredModel | ModelProfile, key: string): StoredModel => {
    const { apiKey: _plain, apiKeyEnc: _enc, ...rest } = profile as StoredModel
    return { ...rest, ...encodeKey(key) }
  }

  const toProfile = (m: StoredModel, apiKey: string): ModelProfile => {
    const { apiKeyEnc: _enc, ...rest } = m
    return { ...rest, apiKey } as ModelProfile
  }

  /** 读取；能加密时顺带把遗留的明文 Key 迁移为密文，并覆盖 .bak 里的明文副本 */
  const load = (): StoredModel[] => {
    const list = readStored()
    if (!list.some((m) => m.apiKey) || !cipher.isAvailable()) return list

    const migrated = list.map((m) => {
      if (!m.apiKey) return m
      // 同时有密文和明文（不应出现）时以密文为准，丢弃明文
      return m.apiKeyEnc ? { ...m, apiKey: '' } : toStored(m, m.apiKey)
    })
    writeJsonFile(filePath, migrated)
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`)
    } catch { /* 备份覆盖失败不影响主文件 */ }
    console.log('[Vela Models] 已把 models.json 中的明文 API Key 迁移为加密存储')
    return migrated
  }

  /**
   * 渲染进程提交的模型配置 → 实际使用的配置。
   * Key 为打码值时换成已保存的 Key；前提是接口地址未改，否则要求重新填写。
   */
  const resolveIncoming = (incoming: ModelProfile): ModelProfile => {
    if (!isMaskedApiKey(incoming.apiKey)) return incoming
    const stored = load().find((m) => m.id === incoming.id)
    if (!stored) return { ...incoming, apiKey: '' }
    if (normalizeBaseUrl(stored.baseUrl) !== normalizeBaseUrl(incoming.baseUrl)) {
      throw new ModelKeyError('修改了接口地址后需要重新填写 API Key')
    }
    return { ...incoming, apiKey: decryptKey(stored) }
  }

  return {
    /** 给渲染进程的列表：Key 打码 */
    listForRenderer(): ModelProfile[] {
      return load().map((m) => toProfile(m, maskApiKey(decryptKey(m))))
    },

    /** 主进程内部使用：带真实 Key */
    get(id: string): ModelProfile | null {
      const m = load().find((x) => x.id === id)
      return m ? toProfile(m, decryptKey(m)) : null
    },

    resolveIncoming,

    /** 保存：打码值 = 沿用已保存的 Key；空串 = 清除 Key；其他 = 新 Key */
    save(incoming: ModelProfile): void {
      const resolved = resolveIncoming(incoming)
      const list = load()
      const record = toStored(resolved, typeof resolved.apiKey === 'string' ? resolved.apiKey : '')
      const idx = list.findIndex((m) => m.id === incoming.id)
      if (idx >= 0) list[idx] = record
      else list.push(record)
      writeJsonFile(filePath, list)
    },

    remove(id: string): void {
      writeJsonFile(filePath, load().filter((m) => m.id !== id))
    },
  }
}

const electronCipher: KeyCipher = {
  isAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
}

/** 应用使用的模型配置存储（~/.vela/models.json + safeStorage） */
export const modelStore = createModelStore({ filePath: MODELS_CONFIG_PATH, cipher: electronCipher })
