import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GlobalConfig } from '../../src/shared/ipc-channels'

export const VELA_HOME = path.join(os.homedir(), '.vela')

export function ensureVelaHome() {
  const dirs = [
    VELA_HOME,
    path.join(VELA_HOME, 'prompts'),
    path.join(VELA_HOME, 'logs'),
  ]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}

type JsonReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'corrupt'; error?: unknown }

function tryReadJson<T>(filePath: string): JsonReadResult<T> {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T }
  } catch (error) {
    return { ok: false, reason: 'corrupt', error }
  }
}

/** 把损坏的文件改名隔离（保留原内容以便手工抢救），返回隔离后的路径 */
function quarantineCorruptFile(filePath: string): string | null {
  const target = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    fs.renameSync(filePath, target)
    return target
  } catch {
    return null
  }
}

/**
 * 读取 JSON 配置。
 * 主文件损坏时：先把坏文件隔离（.corrupt-时间戳），再从上一版备份（.bak）恢复；都不可用才回退默认值。
 * 此前解析失败直接回退默认值，下一次写入就会以空数据覆盖掉坏文件
 * （例如 models.json 写到一半崩溃 → 下次保存模型时所有其他模型和 Key 全部丢失）。
 */
export function readJsonFile<T>(filePath: string, fallback: T): T {
  const primary = tryReadJson<T>(filePath)
  if (primary.ok) return primary.value
  if (primary.reason === 'missing') return fallback

  const quarantined = quarantineCorruptFile(filePath)
  console.warn(`[Vela] ${filePath} 已损坏，已另存为 ${quarantined ?? '（隔离失败）'}，尝试从备份恢复:`, primary.error)

  const backup = tryReadJson<T>(`${filePath}.bak`)
  if (backup.ok) {
    try {
      writeJsonFile(filePath, backup.value)
    } catch (e) {
      console.warn(`[Vela] 从备份恢复 ${filePath} 写回失败:`, e)
    }
    return backup.value
  }
  return fallback
}

/** 写入并刷盘，保证 rename 之后看到的是完整内容 */
function writeFileDurable(filePath: string, content: string) {
  const fd = fs.openSync(filePath, 'w')
  try {
    fs.writeSync(fd, content, null, 'utf-8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 原子写入 JSON 配置：先写临时文件并刷盘，再 rename 覆盖目标。
 * 覆盖前把当前（可正常解析的）版本复制为 .bak，供主文件意外损坏时恢复。
 */
export function writeJsonFile(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const content = JSON.stringify(data, null, 2)
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileDurable(tmp, content)
    if (tryReadJson(filePath).ok) {
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`)
      } catch { /* 备份失败不阻断本次写入 */ }
    }
    // Windows 上目标文件偶尔被杀毒软件 / 索引服务短暂占用，稍后重试
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath)
        break
      } catch (e) {
        if (attempt >= 3) throw e
        const until = Date.now() + 50 * attempt
        while (Date.now() < until) { /* 短暂等待后重试 */ }
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    throw e
  }
}

export const GLOBAL_CONFIG_PATH = path.join(VELA_HOME, 'config.json')
export const MODELS_CONFIG_PATH = path.join(VELA_HOME, 'models.json')
export const RECENT_PROJECTS_PATH = path.join(VELA_HOME, 'recent-projects.json')

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  theme: 'dark',
  defaultModelId: null,
  editorFontSize: 16,
  editorFontFamily: 'Noto Serif SC',
  autoSaveInterval: 30,
  proxy: {
    enabled: false,
    type: 'http',
    host: '',
    port: 7890,
  },
}
