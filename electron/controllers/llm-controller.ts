import { ipcMain, BrowserWindow } from 'electron'
import { readJsonFile, writeJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { ModelProfile, GlobalConfig } from '../../src/shared/ipc-channels'
import { LLMFactory } from '../llm/llm-factory'
import { listOllamaModels } from '../llm/ollama-models'
import { modelStore, ModelKeyError } from '../model-store'
import { stripCacheMarkers } from '../../src/shared/prompt-cache'

const activeStreams = new Map<string, AbortController>()

/** 主进程内部取模型配置（带解密后的真实 Key） */
function getModelConfig(modelId: string): ModelProfile | null {
  return modelStore.get(modelId)
}

type ChatMessage = { role: string; content: string }

/**
 * 发给服务商前整理消息：提示词里的缓存分段标记只有 Anthropic 原生协议会用（由其 provider 自行处理），
 * 其他协议原样去掉，模型看到的内容与以前完全一致。
 */
function prepareMessages(model: ModelProfile, messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages)) return []
  if (model.protocol === 'anthropic') return messages
  return messages.map((m) => ({ ...m, content: typeof m.content === 'string' ? stripCacheMarkers(m.content) : m.content }))
}

function applyProxyConfig() {
  try {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    if (config.proxy?.enabled && config.proxy.host) {
      const proxyUrl = config.proxy.type === 'socks5'
        ? `socks5://${config.proxy.host}:${config.proxy.port}`
        : `http://${config.proxy.host}:${config.proxy.port}`
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      process.env.https_proxy = proxyUrl
    } else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.http_proxy
      delete process.env.https_proxy
    }
  } catch { /* 忽略 */ }
}

export function registerLLMController() {
  ipcMain.handle('llm:ollama-models', async (_event, baseUrl: string, apiKey?: string) => {
    try {
      return { success: true, models: await listOllamaModels(baseUrl, apiKey) }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const code = /^(INVALID_URL|INVALID_RESPONSE|HTTP_\d+)$/.test(message) ? message :
        error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION_FAILED'
      return { success: false, models: [], error: code }
    }
  })
  ipcMain.handle('llm:generate', async (_event, request: { modelId: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; responseFormat?: { type: string }; thinking?: boolean }) => {
    try {
      applyProxyConfig()
      const model = getModelConfig(request.modelId)
      if (!model) return { success: false, content: '', error: '未找到模型配置' }

      const provider = LLMFactory.getProvider(model)
      return await provider.generate(model, prepareMessages(model, request.messages), {
        temperature: request.temperature ?? model.temperature,
        maxTokens: request.maxTokens ?? model.maxTokens,
        responseFormat: request.responseFormat,
        thinking: request.thinking,
      })
    } catch (error) {
      return { success: false, content: '', error: String(error) }
    }
  })

  ipcMain.handle('llm:generate-stream', async (event, requestId: string, request: { modelId: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; responseFormat?: { type: string }; thinking?: boolean }) => {
    applyProxyConfig()
    const model = getModelConfig(request.modelId)
    if (!model) return { requestId, started: false }

    const abortController = new AbortController()
    activeStreams.set(requestId, abortController)
    const win = BrowserWindow.fromWebContents(event.sender)

    const provider = LLMFactory.getProvider(model)
    
    // We do not await this globally since it's streaming independently
    provider.generateStream(model, prepareMessages(model, request.messages), {
      temperature: request.temperature ?? model.temperature,
      maxTokens: request.maxTokens ?? model.maxTokens,
      responseFormat: request.responseFormat,
      thinking: request.thinking,
      signal: abortController.signal,
      onChunk: (chunk: string) => win?.webContents.send('llm:stream-chunk', { requestId, chunk }),
      onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }) => {
        win?.webContents.send('llm:stream-done', { requestId, fullText, usage })
        activeStreams.delete(requestId)
      },
      onError: (error: string) => {
        win?.webContents.send('llm:stream-error', { requestId, error })
        activeStreams.delete(requestId)
      },
    })

    return { requestId, started: true }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    const controller = activeStreams.get(requestId)
    if (controller) {
      controller.abort()
      activeStreams.delete(requestId)
      return { success: true }
    }
    return { success: false }
  })

  // 渲染进程只拿到打码后的 Key
  ipcMain.handle('llm:list-models', async () => modelStore.listForRenderer())

  ipcMain.handle('llm:save-model', async (_event, model: ModelProfile) => {
    try {
      if (!model || typeof model.id !== 'string' || !model.id) return { success: false, error: '模型配置无效' }
      modelStore.save(model)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('llm:delete-model', async (_event, modelId: string) => {
    try {
      modelStore.remove(modelId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:set-default-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultModelId
  })

  ipcMain.handle('llm:set-default-embedding-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultEmbeddingModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-embedding-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultEmbeddingModelId ?? null
  })

  ipcMain.handle('llm:set-default-image-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultImageModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-image-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultImageModelId ?? null
  })

  ipcMain.handle('llm:test-connection', async (_event, submitted: ModelProfile) => {
    try {
      applyProxyConfig()
      // 表单里的 Key 是打码值时换成已保存的 Key（接口地址改过则要求重新填写）
      const model = modelStore.resolveIncoming(submitted)

      // Embedding 模型：调用嵌入接口，并返回实际输出维度（便于用户确认配置）
      if (model.purposes?.includes('embedding')) {
        if (model.protocol === 'anthropic') {
          return { success: false, error: 'Anthropic 协议没有 Embedding 接口，请为向量模型选择 OpenAI 兼容或 Gemini 协议' }
        }
        const { generateEmbeddings } = await import('../embedding')
        const vectors = await generateEmbeddings(['hello'], model.protocol, model)
        const dimension = vectors?.[0]?.length
        if (!dimension) {
          return { success: false, error: 'Embedding 接口返回为空，未获取到向量' }
        }
        return { success: true, dimension }
      }

      // 生成模型：发一条极短的聊天请求探活
      const messages = [{ role: 'user', content: 'Say "hello" and nothing else.' }]
      const provider = LLMFactory.getProvider(model)
      const res = await provider.generate(model, messages, {
        temperature: 0.7,
        maxTokens: 10,
      })
      return { success: res.success, error: res.error }
    } catch (error) {
      return { success: false, error: error instanceof ModelKeyError ? error.message : String(error) }
    }
  })
}
