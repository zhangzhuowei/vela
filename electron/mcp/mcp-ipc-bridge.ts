/**
 * MCP IPC 桥接
 *
 * 在 Electron 主进程注册 MCP 相关的 IPC 处理器，
 * 让渲染进程能够通过 IPC 管理和调用 MCP 服务器。
 */

import { ipcMain } from 'electron'
import path from 'node:path'
import { mcpManager } from './mcp-manager'
import { isSamePath } from '../path-guard'

/**
 * 注册所有 MCP IPC 处理器
 * 在 main.ts 中调用
 */
export function registerMCPHandlers(): void {
  // 加载配置文件
  // 只读取默认位置 ~/.vela/mcp_config.json：配置里的 command 会被启动为子进程，
  // 不能让渲染进程指定任意文件作为配置来源
  ipcMain.handle('mcp:load-config', async (_event, configPath?: string) => {
    try {
      const defaultPath = mcpManager.getDefaultConfigPath()
      if (configPath && !isSamePath(path.resolve(String(configPath)), defaultPath)) {
        return { success: false, configs: [], error: `只支持默认配置文件：${defaultPath}` }
      }
      const configs = await mcpManager.loadConfig(defaultPath)
      return { success: true, configs }
    } catch (error) {
      return { success: false, configs: [], error: String(error) }
    }
  })

  // 连接服务器：渲染进程只能指定「连哪一个」，启动参数（command / args / env）一律以配置文件为准，
  // 不采信渲染进程传来的内容——否则拿到 velaAPI 的页面就能让主进程执行任意命令
  ipcMain.handle('mcp:connect', async (_event, requested: { id?: unknown } | undefined) => {
    try {
      const id = typeof requested?.id === 'string' ? requested.id : ''
      if (!id) return { success: false, error: '缺少 MCP 服务器 ID' }
      const configs = await mcpManager.loadConfig(mcpManager.getDefaultConfigPath())
      const config = configs.find((c) => c.id === id)
      if (!config) return { success: false, error: `配置文件中没有名为「${id}」的 MCP 服务器` }
      await mcpManager.connect(config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 断开服务器
  ipcMain.handle('mcp:disconnect', async (_event, serverId: string) => {
    try {
      await mcpManager.disconnect(serverId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 断开所有
  ipcMain.handle('mcp:disconnect-all', async () => {
    try {
      await mcpManager.disconnectAll()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 获取所有可用 Tool
  ipcMain.handle('mcp:list-tools', async () => {
    return mcpManager.getAllTools()
  })

  // 获取所有可用资源
  ipcMain.handle('mcp:list-resources', async () => {
    return mcpManager.getAllResources()
  })

  // 调用 MCP Tool
  ipcMain.handle('mcp:call-tool', async (_event, serverId: string, toolName: string, args: Record<string, unknown>) => {
    return await mcpManager.callTool(serverId, toolName, args)
  })

  // 获取服务器状态
  ipcMain.handle('mcp:get-servers-status', async () => {
    return mcpManager.getServersStatus()
  })

  // 获取默认配置文件路径
  ipcMain.handle('mcp:get-config-path', async () => {
    return mcpManager.getDefaultConfigPath()
  })

  console.log('[MCP] IPC 处理器已注册')
}
