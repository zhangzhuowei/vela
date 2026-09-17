import { ipcMain, dialog } from 'electron'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { ModelProfile, GlobalConfig } from '../../src/shared/ipc-channels'
import { detectImage, requestImageBytes } from '../utils/image-generate'

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

function sanitizeHint(hint?: string): string {
  return (hint || 'image')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .slice(0, 40) || 'image'
}

async function writeProjectImage(
  projectPath: string,
  bytes: Buffer,
  filenameHint?: string,
): Promise<{ path: string; dataUrl: string }> {
  const { ext, mime } = detectImage(bytes)
  const dir = path.join(projectPath, '.vela', 'images')
  await fsPromises.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sanitizeHint(filenameHint)}-${Date.now()}.${ext}`)
  await fsPromises.writeFile(filePath, bytes)
  return {
    path: filePath,
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
  }
}

export function registerImageController() {
  /**
   * 文生图：按模型 protocol 走 OpenAI 兼容 /images/generations 或 Gemini generateContent，
   * 拿到图片后存到 {projectPath}/.vela/images/，返回本地路径 + base64 data URL 供即时显示。
   */
  ipcMain.handle('image:generate', async (_event, payload: {
    model: ModelProfile
    prompt: string
    negativePrompt?: string
    projectPath: string
    size?: string
    filenameHint?: string
  }) => {
    try {
      applyProxyConfig()
      const { model, prompt } = payload
      if (!payload.projectPath) return { success: false, error: '未指定项目路径' }

      const result = await requestImageBytes(model, {
        prompt,
        size: payload.size,
        negativePrompt: payload.negativePrompt,
      })
      if (!result.ok) return { success: false, error: result.error }

      const saved = await writeProjectImage(payload.projectPath, result.bytes, payload.filenameHint)
      return { success: true, ...saved }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * 手动导入图片：弹出文件选择框，把用户选中的图片复制到 {projectPath}/.vela/images/，
   * 返回本地路径 + base64 data URL。用于直接使用官方设定图等外部素材作为人设图，
   * 相比文生图可获得完全准确、跨章节一致的形象。
   */
  ipcMain.handle('image:import', async (_event, payload: {
    projectPath: string
    filenameHint?: string
  }) => {
    try {
      if (!payload?.projectPath) return { success: false, error: '未指定项目路径' }

      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: '选择图片文件',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      const srcPath = result.filePaths[0]
      const bytes = await fsPromises.readFile(srcPath)
      const saved = await writeProjectImage(payload.projectPath, bytes, payload.filenameHint)
      return { success: true, ...saved }
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
