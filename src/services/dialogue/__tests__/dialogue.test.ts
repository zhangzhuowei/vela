import { describe, expect, it } from 'vitest'
import { mergeWorkingState, splitProseAndState } from '../state-protocol'
import { buildDistillMessages, buildSceneMessages } from '../dialogue-prompts'
import { assembleChapterBody } from '../assemble'
import { selectSceneCharacters } from '../select-characters'
import type { SceneData } from '../../../../electron/repositories/scene-repository'

describe('state-protocol', () => {
  it('splits prose and parses the state patch', () => {
    const raw = '月光很亮。\n<state>\n{"紫悦": {"location": "图书馆", "mentalState": "动摇"}}\n</state>'
    const { prose, patch } = splitProseAndState(raw)
    expect(prose).toBe('月光很亮。')
    expect(patch['紫悦'].location).toBe('图书馆')
    expect(patch['紫悦'].mentalState).toBe('动摇')
  })

  it('returns full text and empty patch when no state block', () => {
    const { prose, patch } = splitProseAndState('她没有躲开。')
    expect(prose).toBe('她没有躲开。')
    expect(patch).toEqual({})
  })

  it('tolerates broken json in state block', () => {
    const { prose, patch } = splitProseAndState('正文。\n<state>{oops</state>')
    expect(prose).toBe('正文。')
    expect(patch).toEqual({})
  })

  it('merges patch into working state for known characters only', () => {
    const current = { 紫悦: { location: '山门', mentalState: '平静' } }
    const patch = {
      紫悦: { mentalState: '动摇', recentEvents: '被拥抱' },
      路人甲: { location: '街头' },
    }
    const next = mergeWorkingState(current, patch, ['紫悦'])
    expect(next['紫悦'].location).toBe('山门')
    expect(next['紫悦'].mentalState).toBe('动摇')
    expect(next['紫悦'].recentEvents).toBe('被拥抱')
    expect(next['路人甲']).toBeUndefined()
  })

  it('ignores empty patch values', () => {
    const next = mergeWorkingState({ 紫悦: { location: '山门' } }, { 紫悦: { location: '  ' } }, ['紫悦'])
    expect(next['紫悦'].location).toBe('山门')
  })
})

describe('dialogue-prompts', () => {
  const config = {
    worldSetting: '小马谷，友谊魔法',
    protagonistProfile: '沉默的人类观察者',
    globalGuidance: '克制、短句',
    writingStyle: '第三人称有限视角',
  }
  const characters = [
    {
      name: '紫悦',
      personality: '较真',
      appearance: '紫色鬃毛',
      speechStyle: '引经据典',
      relationships: '主角的邻居',
    },
  ]
  const workingState = { 紫悦: { location: '图书馆', mentalState: '好奇' } }

  it('builds scene messages with bible, cards, state, goals and protocol', () => {
    const messages = buildSceneMessages({
      config,
      characters,
      workingState,
      chapterTitle: '第1章 裂痕初见',
      chapterGoal: '攻略紫悦',
      sceneTitle: '夜谈',
      sceneGoal: '拉近距离',
      turns: [
        { role: 'user', content: '靠近一点' },
        { role: 'assistant', content: '她没有躲开。' },
      ],
      userInput: '继续',
    })
    const system = messages[0].content
    expect(messages[0].role).toBe('system')
    expect(system).toContain('小马谷')
    expect(system).toContain('沉默的人类观察者')
    expect(system).toContain('克制、短句')
    expect(system).toContain('紫悦')
    expect(system).toContain('较真')
    expect(system).toContain('图书馆')
    expect(system).toContain('攻略紫悦')
    expect(system).toContain('夜谈')
    expect(system).toContain('<state>')
    expect(system).toContain('控场')
    expect(messages[1]).toEqual({ role: 'user', content: '靠近一点' })
    expect(messages[2]).toEqual({ role: 'assistant', content: '她没有躲开。' })
    expect(messages[3]).toEqual({ role: 'user', content: '继续' })
  })

  it('injects knowledge base references into the scene system prompt', () => {
    const messages = buildSceneMessages({
      config,
      characters: [],
      workingState: {},
      chapterTitle: '第1章',
      chapterGoal: '',
      sceneTitle: '夜谈',
      sceneGoal: '',
      turns: [],
      references: [
        { fileName: '设定集.md', text: '小马谷的图书馆是一棵大树。' },
        { fileName: '设定集.md', text: '紫悦害怕迟到。' },
      ],
    })
    const system = messages[0].content
    expect(system).toContain('参考设定')
    expect(system).toContain('大树')
    expect(system).toContain('害怕迟到')
    expect(system).toContain('设定集.md')
  })

  it('renders empty reference marker when no references given', () => {
    const messages = buildSceneMessages({
      config,
      characters: [],
      workingState: {},
      chapterTitle: '第1章',
      chapterGoal: '',
      sceneTitle: '夜谈',
      sceneGoal: '',
      turns: [],
    })
    expect(messages[0].content).toContain('参考设定')
    expect(messages[0].content).toContain('（无）')
  })

  it('keeps the state protocol suffix even without references', () => {
    const messages = buildSceneMessages({
      config,
      characters: [],
      workingState: {},
      chapterTitle: '第1章',
      chapterGoal: '',
      sceneTitle: '夜谈',
      sceneGoal: '',
      turns: [],
    })
    expect(messages[0].content).toContain('<state>')
  })

  it('builds distill messages with transcript labels and no-state instruction', () => {
    const messages = buildDistillMessages({
      config,
      characterNames: ['紫悦'],
      chapterTitle: '第1章',
      chapterGoal: '攻略紫悦',
      sceneTitle: '夜谈',
      sceneGoal: '',
      turns: [
        { role: 'user', content: '靠近一点' },
        { role: 'assistant', content: '她没有躲开。' },
      ],
    })
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('蒸馏')
    expect(messages[0].content).toContain('不要')
    const transcript = messages[1].content
    expect(transcript).toContain('控场：靠近一点')
    expect(transcript).toContain('草稿：她没有躲开。')
  })

  it('injects references into the distill system prompt too', () => {
    const messages = buildDistillMessages({
      config,
      characterNames: [],
      chapterTitle: '第1章',
      chapterGoal: '',
      sceneTitle: '夜谈',
      sceneGoal: '',
      turns: [{ role: 'user', content: '靠近' }],
      references: [{ fileName: '文风.md', text: '避免连续短句堆叠。' }],
    })
    expect(messages[0].content).toContain('参考设定')
    expect(messages[0].content).toContain('避免连续短句堆叠')
  })
})

describe('selectSceneCharacters', () => {
  const char = (name: string, role = 'supporting') => ({ name, role, personality: `${name}性格` })

  it('keeps protagonist, blueprint cast, and characters with working state', () => {
    const all = [char('林澈', 'protagonist'), char('紫悦'), char('云宝'), char('珍奇'), char('碧琪')]
    const picked = selectSceneCharacters({
      all,
      blueprintCast: ['紫悦'],
      workingState: { 云宝: { location: '云上' } },
      max: 12,
    })
    const names = picked.map((c) => c.name)
    expect(names).toContain('林澈')
    expect(names).toContain('紫悦')
    expect(names).toContain('云宝')
    expect(names).not.toContain('珍奇')
    expect(names).not.toContain('碧琪')
  })

  it('caps the cast size with protagonist and blueprint cast first', () => {
    const all = [
      char('主角', 'protagonist'),
      ...Array.from({ length: 30 }, (_, i) => char(`配角${i}`)),
    ]
    const picked = selectSceneCharacters({
      all,
      blueprintCast: ['配角0', '配角1'],
      workingState: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`配角${i}`, { location: 'x' }])
      ),
      max: 6,
    })
    expect(picked.length).toBe(6)
    expect(picked[0].name).toBe('主角')
    expect(picked.map((c) => c.name)).toContain('配角0')
    expect(picked.map((c) => c.name)).toContain('配角1')
  })

  it('falls back to all characters (capped) when nothing matches', () => {
    const all = [char('甲'), char('乙'), char('丙')]
    const picked = selectSceneCharacters({ all, blueprintCast: [], workingState: {}, max: 2 })
    expect(picked.length).toBe(2)
  })
})

describe('assembleChapterBody', () => {
  const scene = (seq: number, status: 'open' | 'distilled', body: string): SceneData => ({
    id: seq,
    chapterNumber: 1,
    seq,
    title: `场${seq}`,
    goal: '',
    status,
    body,
    createdAt: '',
    updatedAt: '',
  })

  it('joins distilled scenes in seq order', () => {
    const out = assembleChapterBody([scene(2, 'distilled', '第二场。'), scene(1, 'distilled', '第一场。')])
    expect(out).toBe('第一场。\n\n第二场。')
  })

  it('throws when nothing distilled', () => {
    expect(() => assembleChapterBody([scene(1, 'open', '')])).toThrow()
  })

  it('throws when some scenes are still open', () => {
    expect(() =>
      assembleChapterBody([scene(1, 'distilled', '第一场。'), scene(2, 'open', '')])
    ).toThrow(/未收场/)
  })
})
