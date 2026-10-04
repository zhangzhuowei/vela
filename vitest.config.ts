import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    // 单测都是纯逻辑 / Node 侧代码，不需要 DOM 或 Electron 环境
    environment: 'node',
    // 就近放在 __tests__/ 下的 *.test.ts 自动纳入（此前用显式白名单，新增测试忘了登记就永远不会执行）
    include: [
      'src/**/__tests__/**/*.test.ts',
      'electron/**/__tests__/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      // 基于 node:assert 的独立脚本式测试，setup 与 vitest 不兼容（历史遗留），不纳入
      'src/services/narrative-consistency/__tests__/standalone.test.ts',
    ],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
