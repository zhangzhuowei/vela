import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../src/shared/ipc-channel-list'

/**
 * Vela Preload Script — 向渲染进程暴露受限的 IPC 能力
 *
 * 只放行白名单里的通道（见 src/shared/ipc-channel-list.ts）：渲染进程即使被注入脚本，
 * 也无法借 velaAPI 调用未登记的通道、监听任意事件，或向主进程单向发送消息。
 * 真正的权限边界在主进程（发送方校验、路径约束等），这里是第一道闸。
 */

const allowedInvoke = new Set<string>(INVOKE_CHANNELS)
const allowedEvents = new Set<string>(EVENT_CHANNELS)

function rejectChannel(kind: string, channel: unknown): Error {
  return new Error(`[Vela] 不允许的 IPC ${kind} 通道：${String(channel)}`)
}

contextBridge.exposeInMainWorld('velaAPI', {
  // ===== 双向请求/响应（invoke/handle） =====
  /** 调用主进程并等待结果 */
  invoke: (channel: string, ...args: unknown[]) => {
    if (typeof channel !== 'string' || !allowedInvoke.has(channel)) {
      return Promise.reject(rejectChannel('invoke', channel))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  // ===== 主进程 → 渲染进程事件 =====
  /** 监听主进程推送的事件，返回取消订阅函数 */
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (typeof channel !== 'string' || !allowedEvents.has(channel)) throw rejectChannel('event', channel)
    // 不把 IpcRendererEvent 交给渲染进程（它带有 sender 等可再利用的对象）
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },

  /** 一次性监听 */
  once: (channel: string, callback: (...args: unknown[]) => void) => {
    if (typeof channel !== 'string' || !allowedEvents.has(channel)) throw rejectChannel('event', channel)
    ipcRenderer.once(channel, (_event, ...args) => callback(...args))
  },

  // ===== UI 控制 =====
  /** 设置窗口缩放级别 (Electron WebFrame) */
  setZoomLevel: (level: number) => {
    webFrame.setZoomLevel(level)
  },
  /** 设置绝对缩放比例 */
  setZoomFactor: (factor: number) => {
    webFrame.setZoomFactor(factor)
  },
  /** 等级获取 */
  getZoomLevel: () => {
    return webFrame.getZoomLevel()
  }
})
