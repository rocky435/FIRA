import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./__tests__/setup.ts'],
    // Each file starts an in-memory MongoDB; with every file running at once
    // on a busy machine that can take longer than the 10s default.
    hookTimeout: 60000,
    // Database-backed and property tests run slower when every file runs at once.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['services/**', 'middleware/**', 'routes/**', 'lib/**'],
      exclude: ['node_modules', 'dist', 'seeds', '__tests__'],
      thresholds: {
        // Current baseline (56.6%) - raise as tests are added.
        lines: 55,
      },
    },
  },
});
