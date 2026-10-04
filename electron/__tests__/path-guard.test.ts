import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// path-guard 只从 database 取「当前项目路径」；纯判定函数由测试显式传入上下文，不需要真的加载 SQLite
vi.mock('../database', () => ({ getCurrentProjectPath: () => null }))

const guard = await import('../path-guard')
type Ctx = Parameters<typeof guard.evaluatePathAccess>[2]

const isWindows = process.platform === 'win32'

function touch(file: string, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('path-guard：主进程文件访问约束', () => {
  let root: string
  let home: string
  let proj: string
  let outsideDir: string
  let exportDir: string
  let importDir: string
  let ctx: Ctx

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-pathguard-'))
    home = path.join(root, 'home', '.vela')
    for (const d of ['prompts', 'skills/demo', 'logs']) fs.mkdirSync(path.join(home, d), { recursive: true })
    for (const f of ['models.json', 'models.json.bak', 'config.json.corrupt-2026-09-30', 'recent-projects.json']) touch(path.join(home, f), '[]')
    touch(path.join(home, 'skills', 'demo', 'SKILL.md'))
    touch(path.join(home, 'logs', 'app.log'))

    proj = path.join(root, 'novels', '我的小说')
    touch(path.join(proj, '第1章.txt'))
    touch(path.join(proj, '.vela', 'vela.db'))
    touch(path.join(proj, '.vela', 'vela.db-wal'))
    touch(path.join(proj, '.vela', 'lancedb', 'chunks.lance', 'data.bin'))
    touch(path.join(proj, '.vela', 'backups', 'vela-auto-1.db'))
    touch(path.join(proj, '.vela', 'partial_arch.json'), '{}')

    outsideDir = path.join(root, 'outside')
    touch(path.join(outsideDir, 'secret.txt'))
    exportDir = path.join(root, 'export')
    fs.mkdirSync(exportDir, { recursive: true })
    importDir = path.join(root, 'import')
    touch(path.join(importDir, 'a.txt'))
    touch(path.join(importDir, 'b.txt'))

    ctx = { velaHome: home, projectPath: proj, grants: [] }
  })

  afterEach(() => {
    guard.resetPathGrantsForTest()
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const ok = (target: unknown, access: 'read' | 'write', c: Ctx = ctx) => guard.evaluatePathAccess(target, access, c).ok
  const kind = (target: unknown, access: 'read' | 'write', c: Ctx = ctx) => {
    const r = guard.evaluatePathAccess(target, access, c)
    return r.ok ? 'ok' : r.kind
  }

  describe('evaluatePathAccess', () => {
    it('当前项目内可读写，包括尚不存在的新文件', () => {
      expect(ok(path.join(proj, '第1章.txt'), 'read')).toBe(true)
      expect(ok(path.join(proj, '卷一', '第2章.txt'), 'write')).toBe(true)
      expect(ok(path.join(proj, '.vela', 'partial_arch.json'), 'write')).toBe(true)
      // 渲染进程常用正斜杠拼路径
      expect(ok(`${proj}/.vela/prompts/x.json`, 'write')).toBe(true)
    })

    it('拒绝项目外路径、.. 穿越与同前缀的兄弟目录', () => {
      expect(kind(path.join(outsideDir, 'secret.txt'), 'read')).toBe('outside')
      expect(kind(`${proj}${path.sep}..${path.sep}..${path.sep}outside${path.sep}secret.txt`, 'read')).toBe('outside')
      expect(kind(`${proj}/../../outside/secret.txt`, 'write')).toBe('outside')
      expect(kind(`${proj}-evil${path.sep}x.txt`, 'write')).toBe('outside')
    })

    it('拒绝相对路径、空路径、NUL 与非字符串', () => {
      expect(kind('relative/x.txt', 'read')).toBe('invalid')
      expect(kind('', 'read')).toBe('invalid')
      expect(kind(`${proj}${path.sep}a\0b.txt`, 'write')).toBe('invalid')
      expect(kind(123, 'read')).toBe('invalid')
      expect(kind(undefined, 'read')).toBe('invalid')
    })

    it('项目内部的数据库、向量库与备份一律拒绝，即使位于当前项目内', () => {
      expect(kind(path.join(proj, '.vela', 'vela.db'), 'read')).toBe('forbidden')
      expect(kind(path.join(proj, '.vela', 'vela.db-wal'), 'write')).toBe('forbidden')
      expect(kind(path.join(proj, '.vela', 'lancedb', 'chunks.lance', 'data.bin'), 'read')).toBe('forbidden')
      expect(kind(path.join(proj, '.vela', 'lancedb'), 'read')).toBe('forbidden')
      expect(kind(path.join(proj, '.vela', 'backups', 'vela-auto-1.db'), 'write')).toBe('forbidden')
    })

    it.runIf(isWindows)('Windows：数据流与结尾点号写法不能绕过受保护位置', () => {
      // "文件:流" 可以别名访问同一文件，盘符之后的冒号一律视为非法
      expect(kind(`${path.join(proj, '.vela', 'vela.db')}::$DATA`, 'write')).toBe('invalid')
      expect(kind(`${path.join(proj, '.vela', 'lancedb')}::$INDEX_ALLOCATION${path.sep}x`, 'read')).toBe('invalid')
      expect(kind(`${path.join(proj, '第1章.txt')}:hidden`, 'write')).toBe('invalid')
      // 结尾点号：保守地按受保护位置处理
      expect(kind(`${path.join(proj, '.vela')}.${path.sep}vela.db`, 'write')).toBe('forbidden')
      // Node 的文件操作走 \\?\ 长路径，".vela." 不会被当成 ".vela"；无论如何都不能放行
      const r = guard.evaluatePathAccess(`${home}.${path.sep}models.json`, 'read', {
        ...ctx, grants: [{ path: guard.canonicalizePath(root), access: 'write' }],
      })
      if (r.ok) expect(fs.existsSync(r.path)).toBe(false)
    })

    it('~/.vela：prompts 读写、skills 只读，配置文件及其副本、logs、根目录本身一律拒绝', () => {
      expect(ok(path.join(home, 'prompts', 'chapter.json'), 'write')).toBe(true)
      expect(ok(path.join(home, 'skills', 'demo', 'SKILL.md'), 'read')).toBe(true)
      expect(kind(path.join(home, 'skills', 'demo', 'SKILL.md'), 'write')).toBe('forbidden')
      for (const f of ['models.json', 'models.json.bak', 'config.json.corrupt-2026-09-30', 'recent-projects.json', 'new.json']) {
        expect(kind(path.join(home, f), 'read')).toBe('forbidden')
        expect(kind(path.join(home, f), 'write')).toBe('forbidden')
      }
      expect(kind(path.join(home, 'logs', 'app.log'), 'read')).toBe('forbidden')
      expect(kind(home, 'read')).toBe('forbidden')
    })

    it('授权覆盖 ~/.vela 所在目录时，配置文件仍然拒绝', () => {
      const c: Ctx = { ...ctx, grants: [{ path: guard.canonicalizePath(root), access: 'write' }] }
      expect(kind(path.join(home, 'models.json'), 'read', c)).toBe('forbidden')
      expect(kind(path.join(proj, '.vela', 'vela.db'), 'write', c)).toBe('forbidden')
      expect(ok(path.join(outsideDir, 'secret.txt'), 'read', c)).toBe(true)
    })

    it('~/.vela 下用户自建的子目录按普通规则判断（项目可以放在这里）', () => {
      const inner = path.join(home, 'my-novel')
      touch(path.join(inner, 'a.txt'))
      expect(ok(path.join(inner, 'a.txt'), 'read', { ...ctx, projectPath: inner })).toBe(true)
      expect(kind(path.join(inner, 'a.txt'), 'read')).toBe('outside')
    })

    it('会话授权：选中的文件夹可读写其内部；选中的文件只读，且不外溢到同目录其他文件', () => {
      const c: Ctx = {
        ...ctx,
        grants: [
          { path: guard.canonicalizePath(exportDir), access: 'write' },
          { path: guard.canonicalizePath(path.join(importDir, 'a.txt')), access: 'read' },
        ],
      }
      expect(ok(path.join(exportDir, '书名', 'chapter_1.md'), 'write', c)).toBe(true)
      expect(ok(path.join(importDir, 'a.txt'), 'read', c)).toBe(true)
      expect(kind(path.join(importDir, 'a.txt'), 'write', c)).toBe('outside')
      expect(kind(path.join(importDir, 'b.txt'), 'read', c)).toBe('outside')
    })

    it('符号链接 / 目录联接不能把访问带出项目', () => {
      const links = [path.join(proj, 'link'), path.join(proj, 'cfg')]
      fs.symlinkSync(outsideDir, links[0], 'junction')
      fs.symlinkSync(home, links[1], 'junction')
      try {
        expect(kind(path.join(proj, 'link', 'secret.txt'), 'read')).toBe('outside')
        expect(kind(path.join(proj, 'link', 'new.txt'), 'write')).toBe('outside')
        expect(kind(path.join(proj, 'cfg', 'models.json'), 'read')).toBe('forbidden')
      } finally {
        // 先拆掉联接本身（不动目标）：Windows 上 fs.rmSync 递归删除遇到目录联接会中途停下且不报错，
        // afterEach 之后临时目录会残留
        for (const link of links) {
          try { fs.unlinkSync(link) } catch { fs.rmdirSync(link) }
        }
      }
    })

    it.runIf(isWindows)('Windows：路径大小写不同仍视为同一位置', () => {
      expect(ok(path.join(proj.toUpperCase(), '第1章.txt'), 'read')).toBe(true)
      expect(kind(path.join(home.toUpperCase(), 'MODELS.JSON'), 'read')).toBe('forbidden')
    })
  })

  describe('evaluateProjectOpenAccess', () => {
    const noneKnown = () => false

    it('最近项目、经对话框选中的目录可以打开', () => {
      const other = path.join(root, 'novels', '旧书')
      fs.mkdirSync(other, { recursive: true })
      expect(guard.evaluateProjectOpenAccess(other, ctx, (p) => guard.isSamePath(p, other)).ok).toBe(true)
      const granted: Ctx = { ...ctx, grants: [{ path: guard.canonicalizePath(other), access: 'write' }] }
      expect(guard.evaluateProjectOpenAccess(other, granted, noneKnown).ok).toBe(true)
    })

    it('未知目录、只读授权的目录、~/.vela 下的应用目录不能打开', () => {
      const r1 = guard.evaluateProjectOpenAccess(outsideDir, ctx, noneKnown)
      expect(r1.ok ? 'ok' : r1.kind).toBe('outside')
      const readOnly: Ctx = { ...ctx, grants: [{ path: guard.canonicalizePath(importDir), access: 'read' }] }
      const r2 = guard.evaluateProjectOpenAccess(importDir, readOnly, noneKnown)
      expect(r2.ok ? 'ok' : r2.kind).toBe('outside')
      const r3 = guard.evaluateProjectOpenAccess(path.join(home, 'prompts'), ctx, () => true)
      expect(r3.ok ? 'ok' : r3.kind).toBe('forbidden')
      const r4 = guard.evaluateProjectOpenAccess(home, ctx, () => true)
      expect(r4.ok ? 'ok' : r4.kind).toBe('forbidden')
    })
  })

  describe('evaluateProjectCreateAccess', () => {
    const noProject: Ctx = { velaHome: '', projectPath: null, grants: [] }

    it('手动输入的位置：目标目录不存在或为空时允许', () => {
      const c = { ...noProject, velaHome: home }
      expect(guard.evaluateProjectCreateAccess(path.join(root, 'typed', '新书'), c).ok).toBe(true)
      const empty = path.join(root, 'typed', '空目录')
      fs.mkdirSync(empty, { recursive: true })
      touch(path.join(empty, 'Thumbs.db'))
      expect(guard.evaluateProjectCreateAccess(empty, c).ok).toBe(true)
    })

    it('手动输入的位置：目标目录已存在且非空时拒绝；位于授权目录内则允许', () => {
      const c = { ...noProject, velaHome: home }
      const r = guard.evaluateProjectCreateAccess(outsideDir, c)
      expect(r.ok ? 'ok' : r.kind).toBe('outside')
      const granted: Ctx = { ...c, grants: [{ path: guard.canonicalizePath(root), access: 'write' }] }
      expect(guard.evaluateProjectCreateAccess(outsideDir, granted).ok).toBe(true)
    })

    it('不能建在 ~/.vela 根目录或应用目录里', () => {
      const c = { ...noProject, velaHome: home }
      const r1 = guard.evaluateProjectCreateAccess(path.join(home, '新书'), c)
      expect(r1.ok ? 'ok' : r1.kind).toBe('forbidden')
      const r2 = guard.evaluateProjectCreateAccess(path.join(home, 'prompts', '新书'), c)
      expect(r2.ok ? 'ok' : r2.kind).toBe('forbidden')
    })
  })

  describe('toSafeFolderName', () => {
    it('项目名只能成为单段文件夹名', () => {
      expect(toSafe('我的小说')).toBe('我的小说')
      expect(toSafe('../x')).toBe('.._x')
      expect(toSafe('a/b\\c')).toBe('a_b_c')
      expect(toSafe('第一卷：风起')).toBe('第一卷：风起')
      expect(toSafe('Part 1: Rise?')).toBe('Part 1_ Rise_')
      expect(toSafe('  书名...  ')).toBe('书名')
      expect(toSafe('CON')).toBe('_CON')
      expect(toSafe('nul.txt')).toBe('_nul.txt')
      expect(toSafe('...')).toBe('')
      expect(toSafe('   ')).toBe('')
      expect(toSafe(42)).toBe('')
      expect(toSafe('长'.repeat(200)).length).toBe(120)
    })

    function toSafe(v: unknown) {
      return guard.toSafeFolderName(v)
    }
  })

  describe('会话授权（grantPathAccess + checkPathAccess）', () => {
    it('选文件夹授予读写，选文件授予只读；已有写权限时不会被降级', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      guard.grantPathAccess(exportDir, 'write')
      guard.grantPathAccess(path.join(importDir, 'a.txt'), 'read')
      expect(guard.checkPathAccess(path.join(exportDir, 'out.md'), 'write').ok).toBe(true)
      expect(guard.checkPathAccess(path.join(importDir, 'a.txt'), 'read').ok).toBe(true)
      expect(guard.checkPathAccess(path.join(importDir, 'a.txt'), 'write').ok).toBe(false)

      guard.grantPathAccess(exportDir, 'read')
      expect(guard.checkPathAccess(path.join(exportDir, 'out.md'), 'write').ok).toBe(true)

      expect(() => guard.assertPathAccess(path.join(outsideDir, 'secret.txt'), 'read')).toThrow(guard.PathAccessError)
    })
  })
})
