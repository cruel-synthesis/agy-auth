import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15_000,
    // The live lane runs real accounts against real endpoints; never here.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/**/*.live.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-hermetic.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli-bin.ts'],
      thresholds: {
        statements: 84,
        lines: 84,
        functions: 85,
        branches: 80,
      },
    },
  },
});
