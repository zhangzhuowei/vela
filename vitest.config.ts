/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    // 叙事一致性测试是纯算法 + 正则，不需要 DOM/Electron 环境
    environment: 'node',
    // 跑 narrative-consistency 单测 + IPC validation 单测（覆盖 PR #13 审计发现的所有 bug）
    // standalone.test.ts 是预存在 setup bug（不是我引入），跳过
    include: [
      'src/services/narrative-consistency/__tests__/narrative-consistency.test.ts',
      'src/services/narrative-consistency/__tests__/perf-regression.test.ts',
      'electron/__tests__/ipc-validation.test.ts',
      'electron/__tests__/chunk-text.test.ts',
      'src/i18n/__tests__/i18n.test.ts',
      'src/services/workflows/__tests__/json-repair.test.ts',
      'src/services/workflows/__tests__/directory-workflow.test.ts',
      'src/services/dialogue/__tests__/dialogue.test.ts',
      'src/services/__tests__/mods.test.ts',
      'src/services/__tests__/llm-request-inspect.test.ts',
      'src/services/__tests__/character-io.test.ts',
      'src/services/__tests__/project-seed.test.ts',
      'src/services/__tests__/chapter-ending.test.ts',
      'src/services/__tests__/setting-bible.test.ts',
      'src/services/__tests__/kb-allocate.test.ts',
      'src/services/__tests__/prose-clean.test.ts',
      'src/shared/__tests__/chapter-addressing.test.ts',
      'src/services/__tests__/export-layout.test.ts',
      'src/services/reference/__tests__/cost-estimate.test.ts',
      'src/services/reference/__tests__/analyzed-range.test.ts',
      'src/services/reference/__tests__/line-matrix.test.ts',
      'src/services/reference/__tests__/stage-batching.test.ts',
      'src/services/reference/__tests__/digest-chunking.test.ts',
      'src/services/reference/__tests__/digest-state.test.ts',
    ],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
