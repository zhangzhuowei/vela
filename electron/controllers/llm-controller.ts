import { ipcMain, BrowserWindow } from 'electron'
import { readJsonFile, writeJsonFile, MODELS_CONFIG_PATH, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { ModelProfile, GlobalConfig } from '../../src/shared/ipc-channels'
import { LLMFactory } from '../llm/llm-factory'

const activeStreams = new Map<string, AbortController>()

function loadModelConfigs(): ModelProfile[] {
  return readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
}

function saveModelConfigs(models: ModelProfile[]) {
  writeJsonFile(MODELS_CONFIG_PATH, models)
}

function getModelConfig(modelId: string): ModelProfile | null {
  const models = loadModelConfigs()
  return models.find((m) => m.id === modelId) ?? null
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
  ipcMain.handle('llm:generate', async (_event, request: { modelId: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; responseFormat?: { type: string }; thinking?: boolean }) => {
    try {
      applyProxyConfig()
      const model = getModelConfig(request.modelId)
      if (!model) return { success: false, content: '', error: '未找到模型配置' }

      const provider = LLMFactory.getProvider(model)
      return await provider.generate(model, request.messages, {
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

    // 终端可观测性：流式调用的关键节点都打点，排查"一直不出字"类问题时
    // 能直接分辨是没发出去、发出去没响应、还是响应了没内容
    const rid = requestId.slice(0, 8)
    const t0 = Date.now()
    let gotFirstChunk = false
    console.log(`[LLM] ▶ ${model.name} (${model.modelName}) req=${rid}`)

    // 首字超时：慢中转可能挂起不吐一个字节（undici 默认 5 分钟才断），
    // 超阈值主动断开并给出明确错误，避免界面无限等待。
    // 阈值取 240s：kiro 类中转跑大提示词（蒸馏）首字可能超过 90s，实测会误杀，
    // 故放宽到仍先于底层 5 分钟超时、但能容纳慢中转的水位
    const FIRST_BYTE_TIMEOUT_MS = 240_000
    const STALL_TIMEOUT_MS = 120_000
    let firstByteTimedOut = false
    let stalled = false
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const firstByteTimer = setTimeout(() => {
      firstByteTimedOut = true
      abortController.abort()
    }, FIRST_BYTE_TIMEOUT_MS)
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        abortController.abort()
      }, STALL_TIMEOUT_MS)
    }
    const clearTimers = () => {
      clearTimeout(firstByteTimer)
      if (stallTimer) clearTimeout(stallTimer)
    }

    // We do not await this globally since it's streaming independently
    provider.generateStream(model, request.messages, {
      temperature: request.temperature ?? model.temperature,
      maxTokens: request.maxTokens ?? model.maxTokens,
      responseFormat: request.responseFormat,
      thinking: request.thinking,
      signal: abortController.signal,
      onChunk: (chunk: string) => {
        if (!gotFirstChunk) {
          gotFirstChunk = true
          clearTimeout(firstByteTimer)
          console.log(`[LLM] ⋯ ${model.name} 首字 ${Date.now() - t0}ms req=${rid}`)
        }
        armStallTimer()
        win?.webContents.send('llm:stream-chunk', { requestId, chunk })
      },
      onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }) => {
        clearTimers()
        console.log(`[LLM] ✓ ${model.name} ${Date.now() - t0}ms ${fullText.length} 字 req=${rid}`)
        win?.webContents.send('llm:stream-done', { requestId, fullText, usage })
        activeStreams.delete(requestId)
      },
      onError: (error: string) => {
        clearTimers()
        const finalError = firstByteTimedOut
          ? `模型 ${FIRST_BYTE_TIMEOUT_MS / 1000} 秒无首字节响应，已自动断开（中转可能挂起，可重试或换模型）`
          : stalled
            ? `模型 ${STALL_TIMEOUT_MS / 1000} 秒无新输出，已自动断开（流可能被中转挂起，可重试）`
            : error
        console.error(`[LLM] ✗ ${model.name} ${Date.now() - t0}ms req=${rid} ${finalError}`)
        win?.webContents.send('llm:stream-error', { requestId, error: finalError })
        activeStreams.delete(requestId)
      },
    })

    return { requestId, started: true }
  })

  ipcMain.handle('llm:cancel', async (event, requestId: string) => {
    const controller = activeStreams.get(requestId)
    if (controller) {
      controller.abort()
      activeStreams.delete(requestId)
    }
    // 立刻通知渲染进程：有的中转 abort 后不会走 onError，不发这包界面会一直停在「生成中」
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.webContents.send('llm:stream-error', { requestId, error: '已取消生成' })
    return { success: Boolean(controller) }
  })

  ipcMain.handle('llm:list-models', async () => loadModelConfigs())

  // 从服务商 OpenAI 兼容 /models 端点拉取可用模型清单
  ipcMain.handle('llm:fetch-provider-models', async (_event, creds: { baseUrl: string; apiKey: string }) => {
    try {
      applyProxyConfig()
      const base = (creds.baseUrl || '').trim().replace(/\/+$/, '')
      if (!base) return { success: false, models: [], error: '请先填写 Base URL' }
      // base 末尾带版本号（/v1 等）则直接 + /models，否则补 /v1/models
      const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${creds.apiKey || ''}` },
      })
      const text = await res.text()
      if (!res.ok) {
        return { success: false, models: [], error: `上游 ${res.status}: ${text.slice(0, 200)}` }
      }
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        return { success: false, models: [], error: '返回的不是 JSON（Base URL 可能填成了控制台地址）' }
      }
      const list = (data as { data?: Array<{ id?: string }> })?.data
      if (!Array.isArray(list)) {
        return { success: false, models: [], error: '响应缺少 data 数组' }
      }
      const models = list
        .map((m) => (typeof m?.id === 'string' ? m.id : ''))
        .filter(Boolean)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return { success: true, models }
    } catch (error) {
      return { success: false, models: [], error: String(error) }
    }
  })

  ipcMain.handle('llm:save-model', async (_event, model: ModelProfile) => {
    try {
      const models = loadModelConfigs()
      const idx = models.findIndex((m) => m.id === model.id)
      if (idx >= 0) models[idx] = model
      else models.push(model)
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:delete-model', async (_event, modelId: string) => {
    try {
      const models = loadModelConfigs().filter((m) => m.id !== modelId)
      saveModelConfigs(models)
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

  ipcMain.handle('llm:test-connection', async (_event, model: ModelProfile) => {
    try {
      applyProxyConfig()

      // Embedding 模型：调用嵌入接口，并返回实际输出维度（便于用户确认配置）
      if (model.purposes?.includes('embedding')) {
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
      return { success: false, error: String(error) }
    }
  })
}
