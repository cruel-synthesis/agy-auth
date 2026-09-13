import { defineConfig } from 'vitest/config';

/**
 * Live-account lane.
 *
 * These tests talk to real Google endpoints using the operator's own
 * credentials, so they are excluded from `npm test` entirely and run only when
 * AGY_AUTH_LIVE=1 is set deliberately. They deliberately omit the hermetic
 * transport guard the normal suite installs.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    include: ['tests/**/*.live.test.ts'],
    globalSetup: ['./tests/live-setup.ts'],
  },
});
