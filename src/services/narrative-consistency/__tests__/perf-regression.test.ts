/**
 * Performance regression tests for PR #13 fixes
 *
 * 如果将来有人改坏了 Patches 01-04 的优化（regex caching、Set.has、IPC 减少），
 * 这些测试会失败，强制 PR 看到性能退化。
 *
 * 阈值是基线（修复后）的 2-3 倍，避免 CI 抖动误报。
 */
import { describe, it, expect } from 'vitest'
import { validateChapter } from '../index'
import { makeState, makeCanon, makeTimeline } from './fixtures'

function makeChapterContent(numChars: number, numCharacters: number) {
  const characters: Array<{ name: string; location: string }> = []
  for (let i = 0; i < numCharacters; i++) {
    characters.push({
      name: `角色${i}`,
      location: ['青云山', '烈火宗', '天元城', '玄天宗'][i % 4],
    })
  }
  const paragraphs: string[] = []
  let remaining = numChars
  while (remaining > 0) {
    const c = characters[paragraphs.length % numCharacters]
    const para = `${c.name}在${c.location}练剑，回想起过去十年。`
    paragraphs.push(para)
    remaining -= para.length
  }
  return { text: paragraphs.join('\n\n'), characters }
}

function makeBigCanon(numCharacters: number) {
  const characters = []
  for (let i = 0; i < numCharacters; i++) {
    characters.push(makeState({
      character: `角色${i}`,
      knowledge: [`秘密${i}A`],
    }))
  }
  return makeCanon({
    characterStates: characters,
    timeline: makeTimeline(
      Array.from({ length: 30 }, (_, i) => ({
        chapterNumber: Math.floor(i / 5) + 1,
        sequence: (i % 5) + 1,
        characters: [`角色${i % numCharacters}`],
        location: 'X',
        summary: `事件 ${i}`,
      }))
    ),
  })
}

/**
 * 稳定地测一段代码的耗时（毫秒）：先预热（首次调用含 JIT 编译与正则缓存建立的冷启动开销），
 * 再把单次太快的调用在一个样本里重复多次（亚毫秒级计时噪声太大），最后取多个样本的中位数
 * （过滤偶发的 GC 停顿）。返回的是「单次调用」的耗时。
 */
function medianMs(run: () => void, samples = 7): number {
  run()
  const probeStart = performance.now()
  run()
  const probe = Math.max(performance.now() - probeStart, 0.01)
  const repeat = Math.max(1, Math.ceil(5 / probe))

  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const start = performance.now()
    for (let r = 0; r < repeat; r++) run()
    times.push((performance.now() - start) / repeat)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}

/**
 * 绝对耗时随机器差异极大（同一段代码在不同机器 / CI 上可差几十倍，写死毫秒阈值必然误报），
 * 这里断言「增长趋势」：输入翻倍时耗时应近似翻倍（线性，比值约 2）；
 * 若有人改坏了 regex 缓存、Set 查找等优化导致退化成平方级，比值会接近 4，测试失败。
 */
describe('性能回归测试 (Perf Regression Suite)', () => {
  it('正文长度翻倍，validateChapter 耗时近似线性增长', () => {
    const canon = makeBigCanon(20)
    const small = makeChapterContent(10000, 20).text
    const large = makeChapterContent(20000, 20).text
    const tSmall = medianMs(() => validateChapter({ chapterNumber: 5, chapterContent: small, canon }))
    const tLarge = medianMs(() => validateChapter({ chapterNumber: 5, chapterContent: large, canon }))
    expect(tLarge / tSmall).toBeLessThan(3)
  })

  it('角色数翻倍，validateChapter 耗时近似线性增长', () => {
    const text = makeChapterContent(10000, 40).text
    const canonSmall = makeBigCanon(20)
    const canonLarge = makeBigCanon(40)
    const tSmall = medianMs(() => validateChapter({ chapterNumber: 5, chapterContent: text, canon: canonSmall }))
    const tLarge = medianMs(() => validateChapter({ chapterNumber: 5, chapterContent: text, canon: canonLarge }))
    expect(tLarge / tSmall).toBeLessThan(3)
  })

  it('批量校验的章节数翻倍，总耗时近似线性增长（无跨章累积开销）', () => {
    const { text } = makeChapterContent(2000, 5)
    const canon = makeBigCanon(5)
    const runBatch = (count: number) => () => {
      for (let i = 1; i <= count; i++) {
        validateChapter({ chapterNumber: i, chapterContent: text, canon })
      }
    }
    const t100 = medianMs(runBatch(100), 5)
    const t200 = medianMs(runBatch(200), 5)
    expect(t200 / t100).toBeLessThan(3)
  })
})
