import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultOpenBrowser } from '../src/core/oauth.js';
import { KeychainManager } from '../src/core/keychain.js';
import { assertNativeAllowed } from '../src/core/native-guard.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

/**
 * Redirecting HOME isolates file paths only. Native credential stores and
 * application launchers ignore it entirely, so an unmocked code path would
 * otherwise reach the developer's real Keychain, browser or IDE.
 */
describe('Native Operation Isolation', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('fails immediately when the native credential store is read without a test double', () => {
    expect(() => KeychainManager.readAgyTokenState()).toThrow(/native operation/i);
  });

  it('fails immediately when the native credential store is written without a test double', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    expect(() =>
      KeychainManager.writeAgyToken({
        auth_method: 'consumer',
        token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
      })
    ).toThrow(/native operation/i);
  });

  it('fails immediately when a browser launch is attempted without a test double', () => {
    expect(() => defaultOpenBrowser('https://accounts.google.com/o/oauth2/v2/auth')).toThrow(
      /native operation/i
    );
  });

  it('still allows an explicitly installed execSecurity double', () => {
    const spy = vi
      .spyOn(KeychainManager, 'execSecurity')
      .mockReturnValue({ error: new Error('Missing'), status: 44 });
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);

    expect(KeychainManager.readAgyTokenState()).toEqual({ status: 'missing' });
    spy.mockRestore();
  });

  it('honours the double on the write path too, not just the read path', () => {
    // A guard repeated in a caller rather than kept at the single native
    // boundary fires even when a double is installed, which makes the double
    // useless and the write path untestable.
    const spy = vi.spyOn(KeychainManager, 'execSecurity').mockReturnValue({ stdout: '' });
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);

    expect(
      KeychainManager.writeAgyToken({
        auth_method: 'consumer',
        token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
      })
    ).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('keeps the guard in place after a test environment is torn down', () => {
    testEnv.cleanup();
    try {
      // The guard is set for the whole run, not per environment. Tearing an
      // environment down must not hand the rest of the file a native window.
      expect(process.env.AGY_AUTH_NO_NATIVE).toBe('1');
    } finally {
      testEnv = setupTestEnvironment();
    }
  });

  it('permits native operations when the guard is not set', () => {
    // Production has no such variable, so the guard must not be unconditional.
    // Only the guard function runs here, and the variable is restored in the
    // same synchronous block: nothing native can be reached in between.
    const original = process.env.AGY_AUTH_NO_NATIVE;
    try {
      delete process.env.AGY_AUTH_NO_NATIVE;
      expect(() => assertNativeAllowed('probe')).not.toThrow();
    } finally {
      process.env.AGY_AUTH_NO_NATIVE = original;
    }
    expect(process.env.AGY_AUTH_NO_NATIVE).toBe('1');
  });
});
