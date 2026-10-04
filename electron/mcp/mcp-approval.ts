/**
 * MCP 服务器首次运行确认
 *
 * stdio 服务器会以当前用户的权限启动任意命令。每份启动配置（command / args / env 的指纹）第一次运行前，
 * 由主进程弹出系统原生对话框请用户确认（渲染进程无法伪造或绕过）；允许后记入 ~/.vela/mcp-approvals.json，
 * 之后同一配置不再询问，配置有任何改动则需要重新确认。
 * 拒绝只在本次运行内生效（下次启动会再问）；不想要的服务器请从 mcp_config.json 中删除。
 */
import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import path from 'node:path'
import { VELA_HOME, readJsonFile, writeJsonFile } from '../utils/config-utils'
import { computeMcpFingerprint, type MCPLaunchSpec } from './mcp-launch'

export const MCP_APPROVALS_PATH = path.join(VELA_HOME, 'mcp-approvals.json')

interface ApprovalRecord {
  fingerprint: string
  serverId: string
  command: string
  approvedAt: string
}

interface ApprovalFile {
  version: 1
  approvals: ApprovalRecord[]
}

export interface McpApproverDeps {
  /** 审批记录文件 */
  approvalsPath: string
  /** 弹出确认框；用户选择「允许」时返回 true */
  confirm: (options: MessageBoxOptions) => Promise<boolean>
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 对话框里展示的启动配置。env 只列变量名：值里常有 Token，不在界面上明文显示 */
function describeSpec(serverId: string, spec: MCPLaunchSpec, configPath: string): string {
  const args = (spec.args ?? []).map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')
  const envKeys = Object.keys(spec.env ?? {})
  return [
    `服务器：${serverId}`,
    `命令：${truncate(spec.command ?? '', 300)}`,
    `参数：${args ? truncate(args, 1200) : '（无）'}`,
    `环境变量：${envKeys.length > 0 ? truncate(envKeys.join(', '), 300) : '（无）'}`,
    `配置文件：${configPath}`,
    '',
    '该程序将以你的用户权限运行，可以读写本机文件、访问网络。只在你信任这份配置的来源时允许。',
  ].join('\n')
}

/** 创建审批器（依赖可注入，便于测试） */
export function createMcpApprover(deps: McpApproverDeps) {
  /** 本次运行中被拒绝的指纹（避免同一次运行里反复弹窗） */
  const deniedThisSession = new Set<string>()
  /** 对话框串行弹出，避免多个服务器同时启动时对话框叠在一起 */
  let queue: Promise<unknown> = Promise.resolve()

  const loadApprovals = (): ApprovalRecord[] => {
    const data = readJsonFile<Partial<ApprovalFile>>(deps.approvalsPath, { version: 1, approvals: [] })
    return Array.isArray(data?.approvals)
      ? data.approvals.filter((a): a is ApprovalRecord => typeof a?.fingerprint === 'string')
      : []
  }

  /** 请求启动许可：已允许过的配置直接返回 true；本次运行已拒绝过的返回 false；否则弹出确认框 */
  const request = (serverId: string, spec: MCPLaunchSpec, configPath: string): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const fingerprint = computeMcpFingerprint(spec)
      if (loadApprovals().some((a) => a.fingerprint === fingerprint)) return true
      if (deniedThisSession.has(fingerprint)) return false

      const allowed = await deps.confirm({
        type: 'warning',
        title: 'MCP 服务器首次运行确认',
        message: `允许启动 MCP 服务器「${serverId}」吗？`,
        detail: describeSpec(serverId, spec, configPath),
        buttons: ['允许并记住', '拒绝'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      if (!allowed) {
        deniedThisSession.add(fingerprint)
        return false
      }

      const approvals = loadApprovals().filter((a) => a.fingerprint !== fingerprint)
      approvals.push({ fingerprint, serverId, command: spec.command ?? '', approvedAt: new Date().toISOString() })
      writeJsonFile(deps.approvalsPath, { version: 1, approvals } satisfies ApprovalFile)
      return true
    }

    const result = queue.then(run, run)
    queue = result.catch(() => undefined)
    return result
  }

  return { request }
}

/** 系统原生确认框（第一个按钮为「允许」） */
async function confirmWithNativeDialog(options: MessageBoxOptions): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return response === 0
}

const defaultApprover = createMcpApprover({ approvalsPath: MCP_APPROVALS_PATH, confirm: confirmWithNativeDialog })

/** 启动 stdio MCP 服务器前调用：返回 false 表示用户拒绝 */
export function requestMcpLaunchApproval(serverId: string, spec: MCPLaunchSpec, configPath: string): Promise<boolean> {
  return defaultApprover.request(serverId, spec, configPath)
}
