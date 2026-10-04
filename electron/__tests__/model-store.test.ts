import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelProfile } from '../../src/shared/ipc-channels'

// 模块顶层会用 electron 的 safeStorage 创建默认实例；测试只用注入依赖的 createModelStore
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
}))

const { createModelStore, maskApiKey, isMaskedApiKey, ModelKeyError } = await import('../model-store')

/** 可逆的假加密：足以验证「文件里没有明文」与往返 */
function fakeCipher(available = true) {
  return {
    isAvailable: () => available,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`).toString('base64'),
    decrypt: (encoded: string) => {
      const text = Buffer.from(encoded, 'base64').toString()
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    },
  }
}

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'm1',
    name: 'DeepSeek',
    provider: 'deepseek',
    protocol: 'openai',
    modelName: 'deepseek-chat',
    apiKey: 'sk-live-1234567890abcd',
    baseUrl: 'https://api.deepseek.com',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
    ...overrides,
  }
}

describe('model-store：API Key 加密存储与打码下发', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-models-'))
    file = path.join(dir, 'models.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const readRaw = () => fs.readFileSync(file, 'utf-8')

  it('打码：长 Key 只露末 4 位，短 Key 全部隐藏，空 Key 保持为空', () => {
    expect(maskApiKey('sk-live-1234567890abcd')).toBe('••••••••abcd')
    expect(maskApiKey('short')).toBe('••••••••')
    expect(maskApiKey('')).toBe('')
    expect(isMaskedApiKey('••••••••abcd')).toBe(true)
    expect(isMaskedApiKey('sk-abc')).toBe(false)
  })

  it('保存后文件里只有密文；渲染进程拿到打码值，主进程内部拿到真实 Key', () => {
    const store = createModelStore({ filePath: file, cipher: fakeCipher() })
    store.save(profile())
    expect(readRaw()).not.toContain('sk-live-1234567890abcd')
    expect(JSON.parse(readRaw())[0].apiKeyEnc).toBeTruthy()

    expect(store.listForRenderer()[0].apiKey).toBe('••••••••abcd')
    expect(store.get('m1')?.apiKey).toBe('sk-live-1234567890abcd')
  })

  it('旧版明文 Key 首次读取时迁移为密文，.bak 里的明文副本也被覆盖', () => {
    const legacy = JSON.stringify([profile()], null, 2)
    fs.writeFileSync(file, legacy)
    fs.writeFileSync(`${file}.bak`, legacy)

    const store = createModelStore({ filePath: file, cipher: fakeCipher() })
    expect(store.get('m1')?.apiKey).toBe('sk-live-1234567890abcd')
    expect(readRaw()).not.toContain('sk-live-1234567890abcd')
    expect(fs.readFileSync(`${file}.bak`, 'utf-8')).not.toContain('sk-live-1234567890abcd')
  })

  it('保存时：打码值沿用已保存的 Key，新值替换，空串清除', () => {
    const store = createModelStore({ filePath: file, cipher: fakeCipher() })
    store.save(profile())

    store.save(profile({ apiKey: '••••••••abcd', name: '改了名字' }))
    expect(store.get('m1')?.apiKey).toBe('sk-live-1234567890abcd')
    expect(store.get('m1')?.name).toBe('改了名字')

    // 在打码值上做了局部修改：仍按沿用处理，不会把打码字符当成 Key 存下
    store.save(profile({ apiKey: '••••••••abcdx' }))
    expect(store.get('m1')?.apiKey).toBe('sk-live-1234567890abcd')

    store.save(profile({ apiKey: 'sk-new-key-0000' }))
    expect(store.get('m1')?.apiKey).toBe('sk-new-key-0000')

    store.save(profile({ apiKey: '' }))
    expect(store.get('m1')?.apiKey).toBe('')
  })

  it('接口地址改了却沿用打码的 Key：拒绝保存 / 测试，已保存的数据不变', () => {
    const store = createModelStore({ filePath: file, cipher: fakeCipher() })
    store.save(profile())
    const before = readRaw()

    const hijack = profile({ apiKey: '••••••••abcd', baseUrl: 'https://evil.example' })
    expect(() => store.save(hijack)).toThrow(ModelKeyError)
    expect(() => store.resolveIncoming(hijack)).toThrow(ModelKeyError)
    expect(readRaw()).toBe(before)

    // 只是末尾斜杠 / 大小写不同，视为同一地址
    expect(store.resolveIncoming(profile({ apiKey: '••••••••abcd', baseUrl: 'https://API.deepseek.com/' })).apiKey)
      .toBe('sk-live-1234567890abcd')
    // 重新填写了 Key，改地址没问题
    expect(store.resolveIncoming(profile({ apiKey: 'sk-typed', baseUrl: 'https://other.example' })).apiKey).toBe('sk-typed')
  })

  it('渲染进程夹带的 apiKeyEnc 不会被写入', () => {
    const store = createModelStore({ filePath: file, cipher: fakeCipher() })
    const forged = { ...profile({ apiKey: '' }), apiKeyEnc: Buffer.from('enc:stolen').toString('base64') } as ModelProfile
    store.save(forged)
    expect(store.get('m1')?.apiKey).toBe('')
    expect(JSON.parse(readRaw())[0].apiKeyEnc).toBeUndefined()
  })

  it('系统不支持加密时退回明文保存，但下发给渲染进程的仍是打码值', () => {
    const store = createModelStore({ filePath: file, cipher: fakeCipher(false) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.save(profile())
    expect(JSON.parse(readRaw())[0].apiKey).toBe('sk-live-1234567890abcd')
    expect(store.listForRenderer()[0].apiKey).toBe('••••••••abcd')
    vi.restoreAllMocks()
  })

  it('密文无法解密（换了电脑 / 账户）时按未填写处理', () => {
    fs.writeFileSync(file, JSON.stringify([{ ...profile(), apiKey: '', apiKeyEnc: Buffer.from('garbage').toString('base64') }]))
    const store = createModelStore({ filePath: file, cipher: fakeCipher() })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(store.get('m1')?.apiKey).toBe('')
    expect(store.listForRenderer()[0].apiKey).toBe('')
    vi.restoreAllMocks()
  })

  it('删除模型', () => {
    const store = createModelStore({ filePath: file, cipher: fakeCipher() })
    store.save(profile())
    store.save(profile({ id: 'm2', apiKey: 'sk-second-key-9999' }))
    store.remove('m1')
    expect(store.get('m1')).toBeNull()
    expect(store.get('m2')?.apiKey).toBe('sk-second-key-9999')
  })
})
