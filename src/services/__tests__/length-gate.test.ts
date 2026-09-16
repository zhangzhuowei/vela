import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LENGTH_FLOOR_RATIO, OVERSHOOT_RATIO,
  countProseChars, resolveLengthFloorRatio, lengthFloor, isOvershoot, trimOverlap, appendContinuation,
} from '../length-gate'

describe('countProseChars', () => {
  it('ignores whitespace and counts CJK punctuation as characters', () => {
    expect(countProseChars('你好，世界。\n\n  第二段')).toBe(9)
    expect(countProseChars('')).toBe(0)
  })
})

describe('resolveLengthFloorRatio', () => {
  it('falls back to the default for missing / invalid values and clamps to [0.5, 1]', () => {
    expect(resolveLengthFloorRatio(undefined)).toBe(DEFAULT_LENGTH_FLOOR_RATIO)
    expect(resolveLengthFloorRatio('x')).toBe(DEFAULT_LENGTH_FLOOR_RATIO)
    expect(resolveLengthFloorRatio(0)).toBe(DEFAULT_LENGTH_FLOOR_RATIO)
    expect(resolveLengthFloorRatio(0.3)).toBe(0.5)
    expect(resolveLengthFloorRatio(1.7)).toBe(1)
    expect(resolveLengthFloorRatio(0.9)).toBe(0.9)
  })
  it('accepts percentages given as 50–100', () => {
    expect(resolveLengthFloorRatio(85)).toBe(0.85)
  })
})

describe('lengthFloor / isOvershoot', () => {
  it('rounds the floor and flags overshoot above the cap', () => {
    expect(lengthFloor(3000, 0.85)).toBe(2550)
    expect(lengthFloor(0, 0.85)).toBe(0)
    expect(isOvershoot(3800, 3000)).toBe(true)
    expect(isOvershoot(3700, 3000)).toBe(false)
    expect(OVERSHOOT_RATIO).toBe(1.25)
  })
})

describe('trimOverlap', () => {
  const existing = '前面很长的一段正文。他推开门，风灌了进来。“你来了。”她说。'
  it('strips a repeated tail sentence from the head of the continuation', () => {
    const added = '“你来了。”她说。他没有回答，只是把伞收好。'
    expect(trimOverlap(existing, added)).toBe('他没有回答，只是把伞收好。')
  })
  it('strips a repeated last paragraph even with leading whitespace', () => {
    const added = '\n\n风灌了进来。“你来了。”她说。\n\n他没有回答。'
    expect(trimOverlap(existing, added)).toBe('他没有回答。')
  })
  it('leaves the continuation alone when the overlap is shorter than the minimum', () => {
    const added = '说。他没有回答。'
    expect(trimOverlap(existing, added)).toBe('说。他没有回答。')
  })
  it('leaves unrelated text alone', () => {
    expect(trimOverlap(existing, '第二天清晨。')).toBe('第二天清晨。')
  })
})

describe('appendContinuation', () => {
  it('joins with a blank line and dedupes the overlap', () => {
    const out = appendContinuation('第一段。这是结尾一句话啊。\n', '  这是结尾一句话啊。第二段开始。  ')
    expect(out).toBe('第一段。这是结尾一句话啊。\n\n第二段开始。')
  })
  it('returns the original when the continuation is fully redundant', () => {
    expect(appendContinuation('唯一的一句话在这里。', '唯一的一句话在这里。')).toBe('唯一的一句话在这里。')
  })
})
