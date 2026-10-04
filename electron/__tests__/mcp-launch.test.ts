import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildMcpEnv, computeMcpFingerprint, escapeCmdArgument, resolveSpawn, resolveWindowsCommand,
} from '../mcp/mcp-launch'

const isWindows = process.platform === 'win32'

describe('buildMcpEnv：MCP 子进程环境变量白名单', () => {
  it('只继承基础变量与代理设置，Token 类变量与 ELECTRON_RUN_AS_NODE 不继承；配置里的 env 优先', () => {
    const source = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      OPENAI_API_KEY: 'sk-secret',
      ELECTRON_RUN_AS_NODE: '1',
    }
    const env = buildMcpEnv({ GITHUB_TOKEN: 'ghp_x', PATH: '/custom/bin' }, source)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.GITHUB_TOKEN).toBe('ghp_x')
    expect(env.PATH).toBe('/custom/bin')
  })

  it('跳过 bash 导出的函数定义与非字符串值', () => {
    const env = buildMcpEnv({ A: 1, B: 'ok' }, { PATH: '() { :; }' })
    expect(env.PATH).toBeUndefined()
    expect(env.A).toBeUndefined()
    expect(env.B).toBe('ok')
  })
})

describe('computeMcpFingerprint：启动配置指纹', () => {
  it('与 env 键顺序无关；command / args / env 任何变化都会改变指纹', () => {
    const base = { command: 'npx', args: ['-y', 'pkg'], env: { A: '1', B: '2' } }
    const fp = computeMcpFingerprint(base)
    expect(computeMcpFingerprint({ ...base, env: { B: '2', A: '1' } })).toBe(fp)
    expect(computeMcpFingerprint({ ...base, args: ['-y', 'pkg2'] })).not.toBe(fp)
    expect(computeMcpFingerprint({ ...base, command: 'npx.cmd' })).not.toBe(fp)
    expect(computeMcpFingerprint({ ...base, env: { A: '1', B: '3' } })).not.toBe(fp)
    expect(computeMcpFingerprint({ ...base, env: { ...base.env, NODE_OPTIONS: '--require x.js' } })).not.toBe(fp)
  })
})

describe('escapeCmdArgument：cmd.exe 参数转义', () => {
  it('整体加引号，并对 cmd 元字符（含引号本身）加 ^', () => {
    expect(escapeCmdArgument('foo')).toBe('^"foo^"')
    expect(escapeCmdArgument('foo bar')).toBe('^"foo^ bar^"')
    expect(escapeCmdArgument('a&b|c')).toBe('^"a^&b^|c^"')
    expect(escapeCmdArgument('%PATH%')).toBe('^"^%PATH^%^"')
  })

  it('按 MSVCRT 规则处理反斜杠：结尾与引号前的加倍，其余照原样', () => {
    expect(escapeCmdArgument('C:\\dir\\')).toBe('^"C:\\dir\\\\^"')
    expect(escapeCmdArgument('a\\"b')).toBe('^"a\\\\\\^"b^"')
    expect(escapeCmdArgument('C:\\a\\b')).toBe('^"C:\\a\\b^"')
  })

  it('node_modules/.bin 下的 cmd-shim 需要双重转义', () => {
    expect(escapeCmdArgument('a&b', true)).toBe('^^^"a^^^&b^^^"')
  })
})

describe.runIf(!isWindows)('resolveSpawn（非 Windows）', () => {
  it('原样启动，不经 shell', () => {
    const r = resolveSpawn('npx', ['-y', 'pkg'], { PATH: '/usr/bin' })
    expect(r.command).toBe('npx')
    expect(r.args).toEqual(['-y', 'pkg'])
    expect(r.options.windowsVerbatimArguments).toBeUndefined()
    expect(r.options.shell).toBeUndefined()
  })
})

describe.runIf(isWindows)('resolveSpawn（Windows）', () => {
  let dir: string

  beforeAll(() => {
    // 目录名带空格，覆盖脚本路径含空格的情况
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela mcp '))
    fs.writeFileSync(path.join(dir, 'echo-args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    // 与 npm 生成的 npx.cmd 一样用 %* 把参数转给下一条命令
    fs.writeFileSync(path.join(dir, 'tool.cmd'), `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`)
    fs.writeFileSync(path.join(dir, 'app.exe'), '')
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('按 PATH + PATHEXT 找到命令对应的文件', () => {
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(resolveWindowsCommand('tool', env)?.toLowerCase()).toBe(path.join(dir, 'tool.cmd').toLowerCase())
    expect(resolveWindowsCommand('app', env)?.toLowerCase()).toBe(path.join(dir, 'app.exe').toLowerCase())
    expect(resolveWindowsCommand('app.exe', env)?.toLowerCase()).toBe(path.join(dir, 'app.exe').toLowerCase())
    expect(resolveWindowsCommand('missing', env)).toBeNull()
  })

  it('.exe 直接启动；.cmd 经 cmd.exe 启动，含元字符与空格的参数原样送达', () => {
    // 测试运行在 ELECTRON_RUN_AS_NODE 下，脚本里用同一个可执行文件充当 node
    const env = { ...buildMcpEnv(undefined), PATH: `${dir};${process.env.PATH ?? ''}`, ELECTRON_RUN_AS_NODE: '1' }
    const exe = resolveSpawn('app', ['x'], env)
    expect(exe.command.toLowerCase()).toBe(path.join(dir, 'app.exe').toLowerCase())
    expect(exe.args).toEqual(['x'])

    const args = ['-y', 'a&b', 'with space', 'trailing\\', '%PATH%', 'caret^', 'pipe|gt>lt<', '!bang!', 'semi;comma,', '(paren)', '']
    const launch = resolveSpawn('tool', args, env)
    expect(launch.options.windowsVerbatimArguments).toBe(true)
    const result = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf-8', timeout: 20_000 })
    expect(result.error).toBeUndefined()
    expect(JSON.parse(String(result.stdout))).toEqual(args)
  })

  it('.cmd 的参数包含双引号或换行时拒绝启动', () => {
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(() => resolveSpawn('tool', ['a"b'], env)).toThrow()
    expect(() => resolveSpawn('tool', ['a\nb'], env)).toThrow()
  })
})
