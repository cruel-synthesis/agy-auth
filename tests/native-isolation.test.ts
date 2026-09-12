import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultOpenBrowser } from '../src/core/oauth.js';
import { KeychainManager } from '../src/core/keychain.js';
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

  it('leaves native operations enabled outside an isolated test environment', () => {
    testEnv.cleanup();
    try {
      expect(process.env.AGY_AUTH_NO_NATIVE).toBeUndefined();
    } finally {
      testEnv = setupTestEnvironment();
    }
  });
});
