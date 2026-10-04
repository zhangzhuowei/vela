import { app, BrowserWindow, shell } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { mcpManager } from './mcp/mcp-manager'
import { closeProjectDatabase } from './database'
import { installCloseGuard, deferQuitForFlush } from './window-close-guard'
import { installIpcSenderGuard, isTrustedSenderUrl } from './ipc-sender-guard'

import { fileURLToPath } from 'node:url'
import path from 'node:path'


const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建产物目录结构
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null

// 同一时间只允许一个实例：两个实例会同时打开同一个项目库、同时改写 ~/.vela 下的配置，互相覆盖
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
}

// 再次启动时不开新实例，而是把已有窗口调到前台
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

/** 只把 http(s) 链接交给系统浏览器；file:、javascript: 等其他协议一律忽略 */
function openExternalSafely(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
  } catch { /* 非法 URL，忽略 */ }
}

// 所有页面：不在应用内打开新窗口、不允许导航离开应用页面（包括把文件拖进窗口时的默认跳转）、不允许 <webview>
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isTrustedSenderUrl(url)) return
    event.preventDefault()
    openExternalSafely(url)
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
})

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Vela — AI 小说创作 IDE',
    icon: path.join(process.env.APP_ROOT!, 'build', 'icon.png'),
    // macOS 使用自定义标题栏
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // 安全性设置（sandbox 在当前 Electron 版本里本就是默认值，这里显式写出，防止日后被无意关闭；
      // 预加载脚本是 CJS 写法的单文件，只 require('electron')，可在沙箱内运行）
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })

  if (process.platform === 'darwin') {
    app.dock?.setIcon(path.join(process.env.APP_ROOT!, 'build', 'icon.png'))
  }

  // 隐藏默认菜单栏（Windows/Linux）
  win.setMenuBarVisibility(false)

  // 关窗前先让渲染进程保存未保存的编辑
  installCloseGuard(win)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// macOS: 关闭所有窗口不退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// 退出前统一释放资源：断开全部 MCP 子进程（否则 node/python 子进程残留成孤儿）、
// 关闭 SQLite 与 LanceDB 连接（释放句柄，WAL 正常收尾）
app.on('before-quit', (e) => {
  // 渲染进程还有未保存的编辑：推迟退出，保存完成后会再次发起退出，那时再做下面的清理
  if (deferQuitForFlush(e)) return
  mcpManager.disconnectAll().catch(() => { /* 退出路径，尽力而为 */ })
  try { closeProjectDatabase() } catch { /* 忽略 */ }
})

// macOS: 点击 dock 图标重新创建窗口
app.on('activate', () => {
  if (isPrimaryInstance && BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  // 已有实例在运行：本进程正在退出，不注册处理器也不建窗口
  if (!isPrimaryInstance) return
  // 必须先于任何处理器注册：之后注册的 ipcMain.handle 都会校验调用方是否为本应用页面
  installIpcSenderGuard({ devServerUrl: VITE_DEV_SERVER_URL, rendererDist: RENDERER_DIST })
  registerIPCHandlers()
  registerMCPHandlers()
  createWindow()
})
