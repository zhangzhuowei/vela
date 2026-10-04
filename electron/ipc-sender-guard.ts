import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'

/**
 * IPC 发送方校验
 *
 * 所有 ipcMain.handle 注册的处理器都只接受来自本应用页面的调用：
 * 开发时是 Vite dev server，打包后是 dist/ 下的 index.html。
 * 窗口被导航到外部页面、或出现意外的子 frame 时，那里的脚本即使拿到 velaAPI 也调不动主进程。
 *
 * 做法是在注册任何处理器之前包一层 ipcMain.handle（之后注册的处理器自动受保护，
 * 各 controller 不用逐个改）。必须在 registerIPCHandlers 之前调用。
 */

let trustedPrefixes: string[] = []
let installed = false

const isWindows = process.platform === 'win32'

/** 发送方页面地址是否属于本应用 */
export function isTrustedSenderUrl(url: string, prefixes: string[] = trustedPrefixes): boolean {
  if (!url) return false
  // Windows 下 file:// 路径大小写不敏感（盘符、目录名都可能大小写不同）
  const target = isWindows && url.startsWith('file:') ? url.toLowerCase() : url
  return prefixes.some((prefix) => {
    const p = isWindows && prefix.startsWith('file:') ? prefix.toLowerCase() : prefix
    return target.startsWith(p)
  })
}

/** 由 dev server 地址与打包产物目录计算可信地址前缀 */
export function computeTrustedPrefixes(devServerUrl: string | undefined, rendererDist: string): string[] {
  const prefixes: string[] = []
  if (devServerUrl) prefixes.push(`${new URL(devServerUrl).origin}/`)
  const distUrl = pathToFileURL(rendererDist).href
  prefixes.push(distUrl.endsWith('/') ? distUrl : `${distUrl}/`)
  return prefixes
}

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const url = event.senderFrame?.url ?? ''
  if (!isTrustedSenderUrl(url)) {
    console.warn(`[Vela IPC] 拒绝来自非本应用页面的调用：${channel} ← ${url || '（发送方 frame 已销毁）'}`)
    throw new Error('IPC 调用被拒绝：发送方不是 Vela 应用页面')
  }
}

/** 安装发送方校验（在注册任何 IPC 处理器之前调用一次） */
export function installIpcSenderGuard(options: { devServerUrl?: string; rendererDist: string }): void {
  trustedPrefixes = computeTrustedPrefixes(options.devServerUrl, options.rendererDist)
  if (installed) return
  installed = true

  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    originalHandle(channel, (event, ...args) => {
      assertTrustedSender(event, channel)
      return listener(event, ...args)
    })) as typeof ipcMain.handle
}
