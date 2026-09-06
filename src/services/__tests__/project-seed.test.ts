import { describe, expect, it } from 'vitest'
import { defaultCloneName, parentDir, pickProjectSeed } from '../project-seed'

describe('pickProjectSeed', () => {
  it('keeps novel config and architecture, drops bookkeeping', () => {
    const seed = pickProjectSeed({
      projectName: '碧蓝航线测试',
      characterStates: '不该带走',
      genre: '同人',
      worldSetting: '港区',
      premise: '前提正文',
      charactersArch: '角色图谱',
      worldbuilding: '世界观',
      synopsis: '大纲',
      creationMode: 'dialogue',
      chapterEnding: 'smooth',
    })
    expect(seed.genre).toBe('同人')
    expect(seed.worldSetting).toBe('港区')
    expect(seed.premise).toBe('前提正文')
    expect(seed.charactersArch).toBe('角色图谱')
    expect(seed.worldbuilding).toBe('世界观')
    expect(seed.synopsis).toBe('大纲')
    expect(seed.creationMode).toBe('dialogue')
    expect(seed.chapterEnding).toBe('smooth')
    expect(seed).not.toHaveProperty('projectName')
    expect(seed).not.toHaveProperty('characterStates')
  })
})

describe('defaultCloneName', () => {
  it('appends 副本 once', () => {
    expect(defaultCloneName('碧蓝航线测试')).toBe('碧蓝航线测试 副本')
    expect(defaultCloneName('碧蓝航线测试 副本')).toBe('碧蓝航线测试 副本 2')
  })
})

describe('parentDir', () => {
  it('strips the last segment on both separators', () => {
    expect(parentDir('E:\\Novels\\碧蓝航线测试')).toBe('E:\\Novels')
    expect(parentDir('/Novels/azur')).toBe('/Novels')
  })
})
