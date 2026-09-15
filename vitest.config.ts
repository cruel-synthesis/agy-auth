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
      // The floor is Windows', the lowest of the supported platforms: the
      // POSIX side of every `process.platform` branch is unreachable there, so
      // the same suite reports about a point less than it does on Linux or
      // macOS. `check` is also `prepublishOnly`, so it has to pass wherever a
      // release is cut from.
      thresholds: {
        statements: 83,
        lines: 83,
        functions: 85,
        branches: 80,
      },
    },
  },
});
