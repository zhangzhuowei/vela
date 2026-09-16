import { describe, it, expect } from 'vitest'
import { coerceCharacterState } from '../digest-state'

describe('coerceCharacterState', () => {
  it('leaves a correct pair unchanged', () => {
    expect(coerceCharacterState({ name: '空银子', stage: 'progress', func: 'assist' })).toEqual({
      name: '空银子', stage: 'progress', func: 'assist',
    })
  })

  it('swaps when each field holds the other enum', () => {
    expect(coerceCharacterState({ name: '夏洛特', stage: 'assist', func: 'progress' })).toEqual({
      name: '夏洛特', stage: 'progress', func: 'assist',
    })
  })

  it('clears stage when it was filled with a func value already in func', () => {
    expect(coerceCharacterState({ name: '空银子', stage: 'assist', func: 'assist' })).toEqual({
      name: '空银子', stage: 'none', func: 'assist',
    })
    expect(coerceCharacterState({ name: '天衣', stage: 'mention', func: 'mention' })).toEqual({
      name: '天衣', stage: 'none', func: 'mention',
    })
  })

  it('clears func when it was filled with a stage value already in stage', () => {
    expect(coerceCharacterState({ name: '相沢', stage: 'progress', func: 'none' })).toEqual({
      name: '相沢', stage: 'progress', func: 'mention',
    })
  })

  it('moves a lone func-in-stage into func when func is missing', () => {
    expect(coerceCharacterState({ name: '龙套', stage: 'daily' })).toEqual({
      name: '龙套', stage: 'none', func: 'daily',
    })
  })

  it('does not invent values for unknown strings', () => {
    expect(coerceCharacterState({ name: 'a', stage: 'none', func: 'boss' })).toEqual({
      name: 'a', stage: 'none', func: 'boss',
    })
  })
})
