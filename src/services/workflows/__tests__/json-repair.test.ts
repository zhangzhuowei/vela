/**
 * json-repair 容错解析测试
 *
 * 覆盖 LLM JSON 的三类缺陷及其组合：
 *  1) 字符串值内的裸控制字符（真实换行/制表符）
 *  2) 字符串值内未转义的半角双引号（中文对白）
 *  3) max_tokens 截断导致数组未闭合
 *
 * 重点回归：角色卡提取批次因裸控制字符（含“截断 + 完整元素里带控制字符”）整批失败的 bug。
 */
import { describe, it, expect } from 'vitest'
import {
  escapeControlCharsInStrings,
  escapeStrayQuotesInStrings,
  parseJSONWithRepair,
  parseJSONLenient,
} from '../json-repair'

// 用 fromCharCode 显式构造真实控制字符，避免源码里 \n 转义歧义
const NL = String.fromCharCode(10) // 真实换行
const TAB = String.fromCharCode(9) // 真实制表符

describe('escapeControlCharsInStrings', () => {
  it('转义字符串内部的裸换行，使其可被 JSON.parse', () => {
    const raw = '{"desc":"line1' + NL + 'line2"}'
    expect(() => JSON.parse(raw)).toThrow()
    expect(JSON.parse(escapeControlCharsInStrings(raw))).toEqual({ desc: 'line1' + NL + 'line2' })
  })

  it('转义制表符', () => {
    const raw = '{"desc":"a' + TAB + 'b"}'
    expect(JSON.parse(escapeControlCharsInStrings(raw))).toEqual({ desc: 'a' + TAB + 'b' })
  })

  it('不改动字符串外的格式化空白（对合法 JSON 零副作用）', () => {
    const pretty = '{' + NL + '  "a": 1,' + NL + '  "b": "x"' + NL + '}'
    expect(escapeControlCharsInStrings(pretty)).toBe(pretty)
    expect(JSON.parse(escapeControlCharsInStrings(pretty))).toEqual({ a: 1, b: 'x' })
  })
})

describe('escapeStrayQuotesInStrings', () => {
  it('转义字符串值内部未转义的半角引号（中文对白）', () => {
    const raw = '{"mentalState":"他听见"梦魇"这个名字"}'
    expect(() => JSON.parse(raw)).toThrow()
    expect(JSON.parse(escapeStrayQuotesInStrings(raw))).toEqual({ mentalState: '他听见"梦魇"这个名字' })
  })

  it('正常闭合引号（后接 , } ] :）不被误转义', () => {
    const raw = '{"a":"x","b":"y"}'
    expect(escapeStrayQuotesInStrings(raw)).toBe(raw)
  })
})

describe('parseJSONWithRepair', () => {
  it('合法 JSON 原样解析', () => {
    expect(parseJSONWithRepair('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' })
  })

  it('修复裸控制字符', () => {
    expect(parseJSONWithRepair('{"d":"a' + NL + 'b"}')).toEqual({ d: 'a' + NL + 'b' })
  })

  it('修复游离引号', () => {
    expect(parseJSONWithRepair('{"m":"听见"月"名"}')).toEqual({ m: '听见"月"名' })
  })

  it('同时修复控制字符与游离引号', () => {
    const raw = '{"m":"听见"月"' + NL + '名"}'
    expect(parseJSONWithRepair(raw)).toEqual({ m: '听见"月"' + NL + '名' })
  })

  it('无法修复时抛出错误', () => {
    expect(() => parseJSONWithRepair('{ 这不是 json')).toThrow()
  })
})

describe('parseJSONLenient', () => {
  it('合法数组：truncated=false', () => {
    const r = parseJSONLenient('[{"name":"A"},{"name":"B"}]')
    expect(r.truncated).toBe(false)
    expect(r.data).toEqual([{ name: 'A' }, { name: 'B' }])
  })

  it('外层对象包裹数组：原样返回', () => {
    const r = parseJSONLenient('{"characters":[{"name":"A"}]}')
    expect(r.truncated).toBe(false)
    expect(r.data).toEqual({ characters: [{ name: 'A' }] })
  })

  it('回归：完整数组但含裸控制字符 → 修复而非整批失败', () => {
    const raw = '[{"name":"毛利兰","mentalState":"她想起' + NL + '那个夜晚"}]'
    const r = parseJSONLenient(raw)
    expect(r.truncated).toBe(false)
    expect(r.data).toEqual([{ name: '毛利兰', mentalState: '她想起' + NL + '那个夜晚' }])
  })

  it('截断数组：抢救已完整元素，truncated=true', () => {
    const raw = '[{"name":"A","d":"aa"},{"name":"B","d":"bb"},{"name":"C","d":"cc'
    const r = parseJSONLenient(raw)
    expect(r.truncated).toBe(true)
    expect(r.data).toEqual([
      { name: 'A', d: 'aa' },
      { name: 'B', d: 'bb' },
    ])
  })

  it('回归：截断 + 完整元素里含裸控制字符 → 抢救仍成功（旧实现会抛错）', () => {
    const raw = '[{"name":"A","d":"line1' + NL + 'line2"},{"name":"B"'
    const r = parseJSONLenient(raw)
    expect(r.truncated).toBe(true)
    expect(r.data).toEqual([{ name: 'A', d: 'line1' + NL + 'line2' }])
  })

  it('既非合法 JSON 又无数组可抢救 → 抛错', () => {
    expect(() => parseJSONLenient('总之这不是 JSON')).toThrow()
  })
})
