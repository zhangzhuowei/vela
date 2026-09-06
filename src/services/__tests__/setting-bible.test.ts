import { describe, expect, it } from 'vitest'
import {
  buildSettingDigest,
  defaultModulesForGenre,
  digestChars,
  effectiveSummary,
  isGridEmpty,
  kbDocumentText,
  kbFileName,
  parseGrid,
  serializeGrid,
  SUMMARY_MAX,
  type SettingModuleData,
} from '../setting-bible'

const mod = (over: Partial<SettingModuleData>): SettingModuleData => ({
  id: 1,
  key: 'marriage',
  title: '婚姻制度',
  sortOrder: 0,
  injectMode: 'always',
  body: '',
  summary: '',
  source: 'user',
  kbDocId: '',
  updatedAt: '',
  ...over,
})

describe('four-grid body', () => {
  it('round-trips parse/serialize', () => {
    const body = serializeGrid({ 规则: '一妻多夫。', 例外: '皇族可破。', 进戏: '退婚即羞辱。', 禁止: '不许科普。' })
    const g = parseGrid(body)
    expect(g.规则).toBe('一妻多夫。')
    expect(g.例外).toBe('皇族可破。')
    expect(g.进戏).toBe('退婚即羞辱。')
    expect(g.禁止).toBe('不许科普。')
  })

  it('treats heading-less text as rules', () => {
    expect(parseGrid('# 婚姻\n庶女不得为正室').规则).toBe('庶女不得为正室')
  })

  it('detects empty grid', () => {
    expect(isGridEmpty(serializeGrid({ 规则: '', 例外: '', 进戏: '', 禁止: '' }))).toBe(true)
    expect(isGridEmpty('## 规则\n有内容')).toBe(false)
  })
})

describe('digest', () => {
  it('returns empty string when no always module has content', () => {
    expect(buildSettingDigest([])).toBe('')
    expect(buildSettingDigest([mod({ injectMode: 'retrieval', summary: 'x' })])).toBe('')
    expect(buildSettingDigest([mod({ injectMode: 'always' })])).toBe('')
  })

  it('lists always modules with summary and falls back to first rule paragraph', () => {
    const digest = buildSettingDigest([
      mod({ title: '婚姻制度', summary: '一妻多夫，庶女不得为正室。' }),
      mod({ id: 2, key: 'beauty', title: '美貌等级', body: '## 规则\n三级制，越级婚配须特赦。\n\n第二段不进摘要。' }),
      mod({ id: 3, key: 'off', title: '关闭的', injectMode: 'off', summary: '不该出现' }),
    ])
    expect(digest).toContain('【设定纲要')
    expect(digest).toContain('- 婚姻制度：一妻多夫，庶女不得为正室。')
    expect(digest).toContain('- 美貌等级：三级制，越级婚配须特赦。')
    expect(digest).not.toContain('第二段')
    expect(digest).not.toContain('不该出现')
  })

  it('caps a summary at SUMMARY_MAX', () => {
    const long = '规'.repeat(SUMMARY_MAX + 50)
    expect(effectiveSummary({ summary: long, body: '' }).length).toBe(SUMMARY_MAX)
  })

  it('counts digest chars only for always modules that have content', () => {
    const n = digestChars([
      mod({ summary: '十个字十个字十个字十' }),
      mod({ id: 2, injectMode: 'retrieval', summary: '很多很多' }),
      mod({ id: 3, key: 'empty', title: '空的常驻模块' }),
    ])
    expect(n).toBe('婚姻制度'.length + 10 + 3)
  })
})

describe('knowledge base export', () => {
  it('prefixes every grid with the module title', () => {
    const text = kbDocumentText({ title: '婚姻制度', body: serializeGrid({ 规则: 'A', 例外: '', 进戏: 'C', 禁止: '' }) })
    expect(text).toBe('【婚姻制度·规则】A\n\n【婚姻制度·进戏】C')
  })

  it('sanitises file names', () => {
    expect(kbFileName('婚姻/继承')).toBe('设定·婚姻·继承.md')
  })
})

describe('default module sets', () => {
  it('always includes protagonist config and one always module', () => {
    for (const g of ['古言', '玄幻', '都市', '科幻', '同人', '其他']) {
      const specs = defaultModulesForGenre(g)
      expect(specs.some((s) => s.key === 'protagonist')).toBe(true)
      expect(specs.some((s) => s.injectMode === 'always')).toBe(true)
    }
  })

  it('gives fanfic a canon-hard module that is always injected', () => {
    const canon = defaultModulesForGenre('同人').find((s) => s.key === 'canon_hard')
    expect(canon?.injectMode).toBe('always')
  })
})
