import { describe, it, expect, vi } from 'vitest'

// 只测纯函数；electron 模块在 Node 下不可用，给个空壳
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))

const { computeTrustedPrefixes, isTrustedSenderUrl } = await import('../ipc-sender-guard')

describe('IPC 发送方校验', () => {
  it('开发模式信任 dev server 同源页面', () => {
    const prefixes = computeTrustedPrefixes('http://localhost:5173/', '/app/dist')
    expect(isTrustedSenderUrl('http://localhost:5173/', prefixes)).toBe(true)
    expect(isTrustedSenderUrl('http://localhost:5173/#/editor', prefixes)).toBe(true)
  })

  it('打包后信任 dist 目录下的页面', () => {
    const prefixes = computeTrustedPrefixes(undefined, process.platform === 'win32' ? 'C:\\app\\dist' : '/app/dist')
    const page = process.platform === 'win32' ? 'file:///C:/app/dist/index.html' : 'file:///app/dist/index.html'
    expect(isTrustedSenderUrl(page, prefixes)).toBe(true)
  })

  it('拒绝外部页面、其他本地文件与空地址', () => {
    const prefixes = computeTrustedPrefixes('http://localhost:5173/', process.platform === 'win32' ? 'C:\\app\\dist' : '/app/dist')
    expect(isTrustedSenderUrl('https://evil.example/', prefixes)).toBe(false)
    // 同端口不同主机、或仅前缀相似的地址都不算
    expect(isTrustedSenderUrl('http://localhost:51730/', prefixes)).toBe(false)
    expect(isTrustedSenderUrl(process.platform === 'win32' ? 'file:///C:/app/dist-evil/x.html' : 'file:///app/dist-evil/x.html', prefixes)).toBe(false)
    expect(isTrustedSenderUrl(process.platform === 'win32' ? 'file:///C:/Users/me/Downloads/a.html' : 'file:///home/me/a.html', prefixes)).toBe(false)
    expect(isTrustedSenderUrl('', prefixes)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('Windows 下 file 地址大小写不敏感', () => {
    const prefixes = computeTrustedPrefixes(undefined, 'C:\\App\\Dist')
    expect(isTrustedSenderUrl('file:///c:/app/dist/index.html', prefixes)).toBe(true)
  })
})
