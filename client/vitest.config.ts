import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Pages are covered by the e2e journeys; unit coverage is measured on shared code.
      include: ['src/components/**', 'src/lib/**', 'src/hooks/**'],
      exclude: ['**/*.check.mjs'],
      // Current baseline (8.6%) - raise as tests are added; it only guards against dropping.
      thresholds: {
        lines: 8,
      },
    },
  },
})
