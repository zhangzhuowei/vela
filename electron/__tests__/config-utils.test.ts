import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '../utils/config-utils'

describe('config-utils：JSON 配置的原子写与损坏恢复', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-config-'))
    file = path.join(dir, 'models.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在时返回默认值', () => {
    expect(readJsonFile(file, { a: 1 })).toEqual({ a: 1 })
  })

  it('写入后能读回，且不留下临时文件', () => {
    writeJsonFile(file, [{ id: 'm1' }])
    expect(readJsonFile(file, [])).toEqual([{ id: 'm1' }])
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('覆盖写入时把上一版保存为 .bak', () => {
    writeJsonFile(file, [{ id: 'm1' }])
    writeJsonFile(file, [{ id: 'm1' }, { id: 'm2' }])
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8'))).toEqual([{ id: 'm1' }])
  })

  it('主文件损坏时：隔离坏文件并从备份恢复，而不是回退为空', () => {
    writeJsonFile(file, [{ id: 'm1' }])
    writeJsonFile(file, [{ id: 'm1' }, { id: 'm2' }])
    // 模拟写到一半崩溃留下的半截文件
    fs.writeFileSync(file, '[{"id": "m1"}, {"id": "m', 'utf-8')

    const recovered = readJsonFile<Array<{ id: string }>>(file, [])
    expect(recovered).toEqual([{ id: 'm1' }])

    // 坏文件被改名保留，便于手工抢救
    expect(fs.readdirSync(dir).some((f) => f.startsWith('models.json.corrupt-'))).toBe(true)
    // 主文件已用备份内容写回，之后的读写恢复正常
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual([{ id: 'm1' }])
  })

  it('主文件损坏且没有备份时回退默认值，坏文件仍被保留', () => {
    fs.writeFileSync(file, '{broken', 'utf-8')
    expect(readJsonFile(file, [] as unknown[])).toEqual([])
    expect(fs.readdirSync(dir).some((f) => f.startsWith('models.json.corrupt-'))).toBe(true)
  })
})
