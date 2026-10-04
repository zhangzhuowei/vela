import { app, ipcMain, type BrowserWindow } from 'electron'

/**
 * 关窗前刷盘守卫
 *
 * 编辑中的正文只在渲染进程内存里，直接关窗就丢。流程：
 *   窗口 close / 应用 before-quit → 拦截 → 推送 app:before-close → 渲染进程保存
 *   → app:close-response(proceed) → 放行关闭（或继续退出）/ 取消本次关闭
 *
 * 渲染进程没有声明接管（页面尚未加载完、刚重载、已崩溃）时不拦截，直接放行。
 * 渲染进程迟迟不回复（卡死）时超时强制关闭，窗口不会永远关不掉；
 * 需要用户决定（保存失败待确认）时渲染进程会先发 app:close-hold 停掉倒计时。
 */

/** 等待渲染进程刷盘的最长时间 */
const FLUSH_TIMEOUT_MS = 8000

interface GuardState {
  win: BrowserWindow
  /** 渲染进程已声明接管关窗刷盘 */
  enabled: boolean
  /** 渲染进程已崩溃 / 退出 */
  rendererGone: boolean
  /** 已完成刷盘，放行后续的关闭与退出 */
  allowClose: boolean
  /** 正在等待渲染进程回复 */
  pending: boolean
  /** 本次关闭由退出应用触发，放行后继续退出 */
  quitAfterClose: boolean
  timer: NodeJS.Timeout | null
}

/** 按 webContents.id 索引（macOS 关窗后点 dock 会新建窗口，每个窗口一份状态） */
const guards = new Map<number, GuardState>()
let handlersRegistered = false

function clearTimer(g: GuardState) {
  if (g.timer) {
    clearTimeout(g.timer)
    g.timer = null
  }
}

function needsFlush(g: GuardState): boolean {
  return g.enabled && !g.rendererGone && !g.allowClose
    && !g.win.isDestroyed() && !g.win.webContents.isDestroyed()
}

function proceed(g: GuardState) {
  clearTimer(g)
  g.pending = false
  g.allowClose = true
  if (g.quitAfterClose) {
    app.quit()
  } else if (!g.win.isDestroyed()) {
    g.win.close()
  }
}

function cancel(g: GuardState) {
  clearTimer(g)
  g.pending = false
  g.quitAfterClose = false
}

function requestFlush(g: GuardState) {
  if (g.pending) return
  g.pending = true
  g.win.webContents.send('app:before-close')
  g.timer = setTimeout(() => {
    console.warn('[Vela] 渲染进程未在限定时间内完成关窗前保存，强制关闭')
    proceed(g)
  }, FLUSH_TIMEOUT_MS)
}

function registerHandlersOnce() {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.handle('app:set-close-guard', (event, enabled: boolean) => {
    const g = guards.get(event.sender.id)
    if (g) g.enabled = !!enabled
    return { success: true }
  })

  ipcMain.handle('app:close-hold', (event) => {
    const g = guards.get(event.sender.id)
    if (g?.pending) clearTimer(g)
    return { success: true }
  })

  ipcMain.handle('app:close-response', (event, ok: boolean) => {
    const g = guards.get(event.sender.id)
    if (g?.pending) {
      if (ok) proceed(g)
      else cancel(g)
    }
    return { success: true }
  })
}

/** 为窗口安装关窗前刷盘守卫（创建窗口后调用） */
export function installCloseGuard(win: BrowserWindow): void {
  registerHandlersOnce()

  const id = win.webContents.id
  const g: GuardState = {
    win,
    enabled: false,
    rendererGone: false,
    allowClose: false,
    pending: false,
    quitAfterClose: false,
    timer: null,
  }
  guards.set(id, g)

  win.on('close', (e) => {
    if (!needsFlush(g)) return
    e.preventDefault()
    requestFlush(g)
  })

  win.on('closed', () => {
    clearTimer(g)
    guards.delete(id)
  })

  win.webContents.on('render-process-gone', () => {
    g.rendererGone = true
    // 正在等待回复时渲染进程没了：不会再有回复，直接放行
    if (g.pending) proceed(g)
  })

  // 页面重载：新页面加载完后会重新声明接管，此前不拦截
  win.webContents.on('did-start-loading', () => {
    g.enabled = false
  })
}

/**
 * 应用退出前调用（before-quit 里最先调用）。
 * 还有窗口需要刷盘时推迟本次退出、先让渲染进程保存，返回 true；
 * 调用方此时必须跳过退出清理（关数据库等），否则渲染进程的保存写不进去。
 * 刷盘完成后会再次发起退出，那时本函数返回 false，清理照常进行。
 */
export function deferQuitForFlush(e: Electron.Event): boolean {
  let deferred = false
  for (const g of guards.values()) {
    if (!needsFlush(g)) continue
    deferred = true
    g.quitAfterClose = true
    requestFlush(g)
  }
  if (deferred) e.preventDefault()
  return deferred
}
