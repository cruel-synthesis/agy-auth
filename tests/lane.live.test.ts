import { describe, expect, it } from 'vitest';

/**
 * Smoke test for the live lane itself.
 *
 * It asserts the properties that distinguish this lane from `npm test`: the
 * opt-in flag is set, the hermetic transport guard is absent, and native access
 * is not blocked. It performs no account or network operation of its own.
 */
describe('Live lane preconditions', () => {
  it('runs only when live testing was requested explicitly', () => {
    expect(process.env.AGY_AUTH_LIVE).toBe('1');
  });

  it('has a real fetch and unblocked native access', () => {
    expect(process.env.AGY_AUTH_NO_NATIVE).not.toBe('1');
    expect(String(globalThis.fetch)).not.toContain('must not perform real network requests');
  });
});
