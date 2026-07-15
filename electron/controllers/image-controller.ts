import { ipcMain } from 'electron'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { ModelProfile, GlobalConfig } from '../../src/shared/ipc-channels'

/** 应用代理配置（与 llm-controller 保持一致的 env 方式） */
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
    }
  } catch { /* 忽略 */ }
}

/**
 * 构造文生图端点 URL —— 兼容 baseUrl 带不带版本号两种写法：
 *  - .../v1  → .../v1/images/generations
 *  - .../api/paas/v4 → .../v4/images/generations
 *  - 无版本号 → 追加 /v1/images/generations
 */
function buildImageUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v\d+$/.test(base)) return `${base}/images/generations`
  return `${base}/v1/images/generations`
}

/** 通过魔数识别图片类型，决定扩展名与 MIME */
function detectImage(buf: Buffer): { ext: string; mime: string } {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' }
  }
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { ext: 'gif', mime: 'image/gif' }
  }
  return { ext: 'png', mime: 'image/png' }
}

export function registerImageController() {
  /**
   * 文生图：调用 OpenAI 兼容 / SiliconFlow 图片接口，
   * 拿到图片后存到 {projectPath}/.vela/images/，返回本地路径 + base64 data URL 供即时显示。
   */
  ipcMain.handle('image:generate', async (_event, payload: {
    model: ModelProfile
    prompt: string
    projectPath: string
    size?: string
    filenameHint?: string
  }) => {
    try {
      applyProxyConfig()
      const { model, prompt } = payload
      if (!prompt?.trim()) return { success: false, error: '提示词为空' }
      if (!model?.baseUrl || !model?.modelName) return { success: false, error: '文生图模型配置不完整' }
      if (!payload.projectPath) return { success: false, error: '未指定项目路径' }

      const size = payload.size || '1024x1024'
      const url = buildImageUrl(model.baseUrl)
      const body: Record<string, unknown> = {
        model: model.modelName,
        prompt: prompt.trim(),
        image_size: size, // SiliconFlow / 多数 OpenAI 兼容图片接口
        batch_size: 1,
        n: 1,
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const t = await res.text()
        return { success: false, error: `文生图接口失败 (${res.status}): ${t.slice(0, 300)}` }
      }

      const data = await res.json() as {
        images?: Array<{ url?: string; b64_json?: string }>
        data?: Array<{ url?: string; b64_json?: string }>
      }
      const item = data.images?.[0] ?? data.data?.[0]
      if (!item) return { success: false, error: '接口未返回图片数据' }

      let bytes: Buffer
      if (item.b64_json) {
        bytes = Buffer.from(item.b64_json, 'base64')
      } else if (item.url) {
        const imgRes = await fetch(item.url)
        if (!imgRes.ok) return { success: false, error: `下载生成图失败 (${imgRes.status})` }
        bytes = Buffer.from(await imgRes.arrayBuffer())
      } else {
        return { success: false, error: '接口未返回图片 URL 或 base64' }
      }

      const { ext, mime } = detectImage(bytes)
      const dir = path.join(payload.projectPath, '.vela', 'images')
      await fsPromises.mkdir(dir, { recursive: true })
      const safeHint = (payload.filenameHint || 'image')
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
        .slice(0, 40) || 'image'
      const filePath = path.join(dir, `${safeHint}-${Date.now()}.${ext}`)
      await fsPromises.writeFile(filePath, bytes)

      return {
        success: true,
        path: filePath,
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 读取本地图片为 base64 data URL（用于重新打开项目时显示已存图片） */
  ipcMain.handle('image:read', async (_event, filePath: string) => {
    try {
      const bytes = await fsPromises.readFile(filePath)
      const { mime } = detectImage(bytes)
      return { success: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
