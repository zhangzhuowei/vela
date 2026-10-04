/**
 * 编辑器自动保存与关窗刷盘
 *
 * - 定时保存：按全局配置 autoSaveInterval（秒，0 = 关闭）周期性保存所有未保存的正文 Tab
 * - 关窗刷盘：主进程拦截窗口关闭 → 推送 app:before-close → 这里把未保存 Tab 落盘 → app:close-response
 * - 切换项目：project-store 打开另一个项目前调用 flushDirtyTabs，旧项目的编辑先写回旧项目的库
 *
 * 编辑中的正文只在编辑器组件的 ref 里（键入热路径不写 store），所以已挂载的编辑器要通过
 * registerEditorFlusher 注册「取当前内容 + 保存」的回调；已切走（卸载）的 Tab 在卸载时
 * 已把内容刷回 store，直接按 Tab 上的 content 持久化。
 */
import i18n from '../i18n'
import { ipc } from './ipc-client'
import { persistEditorContent } from './editor-persistence'
import { useEditorStore, type EditorTab } from '../stores/editor-store'
import { toast } from '../components/ui/Toast'
import { confirm } from '../components/ui/Confirm'

export type FlushReason = 'auto' | 'close' | 'switch-project'

/** 已挂载编辑器的保存回调：无需保存时直接返回，保存失败时抛出（由这里统一提示，不在编辑器里弹窗） */
type EditorFlusher = () => Promise<void>

/** 默认自动保存间隔（秒），与主进程 DEFAULT_GLOBAL_CONFIG 保持一致 */
export const DEFAULT_AUTO_SAVE_INTERVAL_SEC = 30
/** 间隔下限：过密的保存会和键入抢 IPC，也没有意义 */
const MIN_AUTO_SAVE_INTERVAL_SEC = 5

/** 按 filePath 索引：DraftEditor 等按 filePath 定位 Tab（个别入口的 Tab id 与 filePath 不同） */
const flushers = new Map<string, EditorFlusher>()

/**
 * 注册已挂载编辑器的保存回调，返回注销函数（组件卸载时调用）。
 * 同一路径重复注册时后者覆盖前者；注销只移除自己注册的那一个。
 */
export function registerEditorFlusher(filePath: string, flush: EditorFlusher): () => void {
  flushers.set(filePath, flush)
  return () => {
    if (flushers.get(filePath) === flush) flushers.delete(filePath)
  }
}

/** 只有正文类 Tab 会被标记为未保存且能按路径写回（配置/角色卡等编辑器自带保存按钮） */
function isPersistableTab(tab: EditorTab): tab is EditorTab & { filePath: string } {
  return (tab.type === 'chapter' || tab.type === 'arch-file') && !!tab.filePath
}

/** 同一路径的自动保存失败只提示一次，保存成功后复位，避免每个周期刷屏 */
const reportedFailures = new Set<string>()

function reportAutoSaveFailure(tab: EditorTab, error: string) {
  const key = tab.filePath ?? tab.id
  if (reportedFailures.has(key)) return
  reportedFailures.add(key)
  toast.error(i18n.t('autoSaveFailed', { ns: 'common', name: tab.name, error }))
}

/** 保存一个未保存的 Tab，失败时抛出 */
async function flushTab(tab: EditorTab & { filePath: string }): Promise<void> {
  const flusher = flushers.get(tab.filePath)
  if (flusher) {
    await flusher()
    return
  }

  // 编辑器已卸载：内容在卸载时已刷回 store
  if (tab.content === undefined) return
  const saved = tab.content
  const res = await persistEditorContent(tab.filePath, saved)
  if (!res.success) throw new Error(res.error || i18n.t('failed', { ns: 'common' }))

  // 落盘期间这个 Tab 可能被重新打开并继续编辑：内容变了或编辑器已挂载就保留未保存标记，
  // 交给编辑器自己的保存逻辑，免得把新输入误标成已保存
  const latest = useEditorStore.getState().tabs.find(t => t.id === tab.id)
  if (latest && latest.content === saved && !flushers.has(tab.filePath)) {
    useEditorStore.getState().markTabSaved(tab.id)
  }
}

/** 逐个保存所有未保存的正文 Tab，返回保存失败的 Tab 名称 */
async function flushOnce(reason: FlushReason): Promise<string[]> {
  const failed: string[] = []
  const dirtyTabs = useEditorStore.getState().tabs.filter(t => t.dirty).filter(isPersistableTab)
  for (const tab of dirtyTabs) {
    try {
      await flushTab(tab)
      reportedFailures.delete(tab.filePath)
    } catch (e) {
      failed.push(tab.name)
      if (reason === 'auto') reportAutoSaveFailure(tab, e instanceof Error ? e.message : String(e))
    }
  }
  return failed
}

// 串行化：自动保存进行中又触发关窗时，关窗那次会排在后面、重新读取未保存 Tab，
// 不会因复用进行中的那次而漏掉它开始之后才变脏的 Tab
let flushChain: Promise<unknown> = Promise.resolve()

/** 保存所有未保存的正文 Tab；返回保存失败的 Tab 名称（空数组 = 全部成功） */
export function flushDirtyTabs(reason: FlushReason): Promise<string[]> {
  const run = flushChain.then(() => flushOnce(reason))
  flushChain = run.catch(() => undefined)
  return run
}

// ===== 定时自动保存 =====

let timer: ReturnType<typeof setInterval> | null = null
let autoRunning = false

/** 规范化配置值：非法值回退默认，0 表示关闭，其余不低于下限 */
export function normalizeAutoSaveInterval(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTO_SAVE_INTERVAL_SEC
  if (n === 0) return 0
  return Math.max(MIN_AUTO_SAVE_INTERVAL_SEC, Math.round(n))
}

async function autoSaveTick() {
  if (autoRunning) return
  if (!useEditorStore.getState().tabs.some(t => t.dirty)) return
  autoRunning = true
  try {
    await flushDirtyTabs('auto')
  } finally {
    autoRunning = false
  }
}

/** 应用新的自动保存间隔（秒，0 = 关闭），立即生效 */
export function applyAutoSaveInterval(seconds: number): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  const sec = normalizeAutoSaveInterval(seconds)
  if (sec > 0) {
    timer = setInterval(() => { void autoSaveTick() }, sec * 1000)
  }
}

// ===== 关窗刷盘 =====

async function handleBeforeClose() {
  let proceed = true
  try {
    const failed = await flushDirtyTabs('close')
    if (failed.length > 0) {
      // 需要用户决定：先让主进程停掉强制关闭倒计时
      await ipc.invoke('app:close-hold').catch(() => undefined)
      proceed = await confirm(
        i18n.t('closeSaveFailedMessage', { ns: 'common', names: failed.join('、') }),
        {
          title: i18n.t('closeSaveFailedTitle', { ns: 'common' }),
          confirmText: i18n.t('closeAnyway', { ns: 'common' }),
          danger: true,
        },
      )
    }
  } catch (e) {
    console.error('[AutoSave] 关窗前保存异常:', e)
  }
  await ipc.invoke('app:close-response', proceed).catch(() => undefined)
}

/**
 * 启动自动保存与关窗刷盘（应用启动时调用一次），返回停止函数。
 */
export function startEditorAutoSave(): () => void {
  let disposed = false

  ipc.invoke('config:get')
    .then((cfg) => {
      if (!disposed) applyAutoSaveInterval(cfg?.autoSaveInterval ?? DEFAULT_AUTO_SAVE_INTERVAL_SEC)
    })
    .catch(() => {
      if (!disposed) applyAutoSaveInterval(DEFAULT_AUTO_SAVE_INTERVAL_SEC)
    })

  const unsubscribe = ipc.on('app:before-close', () => { void handleBeforeClose() })
  ipc.invoke('app:set-close-guard', true).catch(() => undefined)

  return () => {
    disposed = true
    unsubscribe()
    ipc.invoke('app:set-close-guard', false).catch(() => undefined)
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
