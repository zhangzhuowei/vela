import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 模块顶层引用了 electron 的 dialog（默认审批器用）；测试只用注入依赖的 createMcpApprover
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
}))

const { createMcpApprover } = await import('../mcp/mcp-approval')

const spec = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\novels'], env: { TOKEN: 'secret' } }

describe('MCP 首次运行确认', () => {
  let dir: string
  let approvalsPath: string

  beforeEach(() => {
    // 审批记录写到临时目录，不碰真实的 ~/.vela
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-mcp-approval-'))
    approvalsPath = path.join(dir, 'mcp-approvals.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('首次运行弹窗；允许后记住，同一配置不再询问', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const approver = createMcpApprover({ approvalsPath, confirm })
    expect(await approver.request('fs', spec, 'cfg.json')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    // 对话框只列 env 的变量名，不显示值
    const { detail } = confirm.mock.calls[0][0] as { detail: string }
    expect(detail).toContain('TOKEN')
    expect(detail).not.toContain('secret')

    expect(await approver.request('fs', spec, 'cfg.json')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    // 审批结果持久化：新的审批器（相当于下次启动）读取同一文件也不再询问
    const nextRun = createMcpApprover({ approvalsPath, confirm })
    expect(await nextRun.request('fs', spec, 'cfg.json')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('配置有改动（参数、env 值）时需要重新确认', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const approver = createMcpApprover({ approvalsPath, confirm })
    await approver.request('fs', spec, 'cfg.json')
    await approver.request('fs', { ...spec, args: [...spec.args, 'C:\\'] }, 'cfg.json')
    await approver.request('fs', { ...spec, env: { TOKEN: 'other' } }, 'cfg.json')
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it('拒绝后本次运行内不再弹窗，也不写入审批记录；下次启动会再问', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const approver = createMcpApprover({ approvalsPath, confirm })
    expect(await approver.request('x', spec, 'cfg.json')).toBe(false)
    expect(await approver.request('x', spec, 'cfg.json')).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(approvalsPath)).toBe(false)

    const nextRun = createMcpApprover({ approvalsPath, confirm })
    expect(await nextRun.request('x', spec, 'cfg.json')).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('同时发起的多个请求串行弹窗：同一配置只问一次', async () => {
    let release: (allowed: boolean) => void = () => {}
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve }))
    const approver = createMcpApprover({ approvalsPath, confirm })
    const a = approver.request('a', spec, 'cfg.json')
    const b = approver.request('b', spec, 'cfg.json')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    release(true)
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
