import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError, UsageError } from '../src/core/errors.js';
import { fetchVerifiedGoogleEmail, importKeychainOAuth } from '../src/core/keychain-import.js';
import { KeychainManager } from '../src/core/keychain.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { Switcher } from '../src/core/switcher.js';
import { setupTestEnvironment, type TestEnv } from './test-utils.js';

describe('Keychain OAuth Import Module', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('explains the supported fallback when no token file or native keyring is available', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(false);

    await expect(importKeychainOAuth()).rejects.toThrow(CliError);
    await expect(importKeychainOAuth()).rejects.toThrow(/use `--oauth-source browser` instead/);
  });

  it('reports composite session-store errors without mislabeling token-file failures', async () => {
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({ status: 'missing' });
    fs.writeFileSync(Paths.antigravityTokenFile, '{ malformed token file');

    await expect(importKeychainOAuth()).rejects.toMatchObject({
      code: 'session_store_error',
      message: expect.stringMatching(/session store read error/i),
    });
  });

  it('fails when Keychain returns an error', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'error',
      message: 'The user denied access to the Keychain item.',
    });

    await expect(importKeychainOAuth()).rejects.toThrow(/session store read error/i);
  });

  it('fails when no active Antigravity session exists in Keychain', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'missing',
    });

    await expect(importKeychainOAuth()).rejects.toThrow(/No active Antigravity sign-in was found/);
  });

  it('derives and verifies email from userinfo, creating a valid profile without client ID', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'synthetic-access-token',
          refresh_token: 'synthetic-refresh-token',
          token_type: 'Bearer',
          expiry: '2030-01-01T00:00:00.000Z',
        },
      },
    });

    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://www.googleapis.com/oauth2/v3/userinfo');
      return new Response(
        JSON.stringify({ email: 'auto-derived@example.com', email_verified: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const result = await importKeychainOAuth({
      alias: 'auto-profile',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.isNew).toBe(true);
      expect(result.derivedEmail).toBe(true);
      expect(result.verifiedEmail).toBe(true);
      expect(result.account.email).toBe('auto-derived@example.com');
      expect(result.account.status).toBe('valid');
      expect(result.account.alias).toBe('auto-profile');
      expect(result.account.credentials?.keychainPayload?.token.access_token).toBe(
        'synthetic-access-token'
      );
      expect(result.account.credentials?.keychainPayload?.token.refresh_token).toBe(
        'synthetic-refresh-token'
      );
    }
  });

  it('handles userinfo 401, timeout, malformed JSON, and unverified email returning needs_email', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'bad-token',
          refresh_token: '',
          token_type: 'Bearer',
        },
      },
    });

    // 1. 401 Unauthorized
    const fetch401 = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    let res = await importKeychainOAuth({ fetchFn: fetch401 as unknown as typeof fetch });
    expect(res.status).toBe('needs_email');

    // 2. Malformed JSON
    const fetchMalformed = vi.fn(
      async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    res = await importKeychainOAuth({ fetchFn: fetchMalformed as unknown as typeof fetch });
    expect(res.status).toBe('needs_email');

    // 3. Unverified email in userinfo
    const fetchUnverified = vi.fn(
      async () =>
        new Response(JSON.stringify({ email: 'unverified@example.com', email_verified: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    res = await importKeychainOAuth({ fetchFn: fetchUnverified as unknown as typeof fetch });
    expect(res.status).toBe('needs_email');
  });

  it('creates new account as unverified when explicit fallback email is supplied and live check fails', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'offline-token',
          refresh_token: '',
          token_type: 'Bearer',
        },
      },
    });

    const fetchFail = vi.fn(async () => {
      throw new Error('Network offline');
    });

    const result = await importKeychainOAuth({
      email: 'fallback@example.com',
      fetchFn: fetchFail as unknown as typeof fetch,
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.verifiedEmail).toBe(false);
      expect(result.account.email).toBe('fallback@example.com');
      expect(result.account.status).toBe('unverified');
      expect(result.account.verification).toBeUndefined();
    }
  });

  it('preserves valid status and verification record on existing account when userinfo is unavailable', async () => {
    const registry = new RegistryManager();
    const existing = registry.addOrUpdateAccount({
      email: 'valid-user@example.com',
      alias: 'valid-alias',
      authType: 'oauth',
      status: 'valid',
      verification: {
        checkedAt: 1700000000000,
        source: 'userinfo',
      },
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'existing-access-token',
            refresh_token: 'existing-refresh-token',
            token_type: 'Bearer',
          },
        },
      },
    });

    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'new-offline-access-token',
          refresh_token: '',
          token_type: 'Bearer',
        },
      },
    });

    const fetchFail = vi.fn(async () => {
      throw new Error('Network unavailable');
    });

    const result = await importKeychainOAuth({
      email: 'valid-user@example.com',
      fetchFn: fetchFail as unknown as typeof fetch,
      registry,
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.isNew).toBe(false);
      expect(result.verifiedEmail).toBe(false);
      expect(result.account.status).toBe('valid');
      expect(result.account.verification).toEqual({
        checkedAt: 1700000000000,
        source: 'userinfo',
      });
      expect(result.account.credentials?.keychainPayload?.token.refresh_token).toBe(
        'existing-refresh-token'
      );
    }
  });

  it('imports Keychain payload without refresh_token and successfully switches to it', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'valid-active-token',
          refresh_token: '',
          token_type: 'Bearer',
        },
      },
    });
    const writeSpy = vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValue(true);

    const registry = new RegistryManager();
    const imported = registry.addOrUpdateAccount({
      email: 'synthetic.user@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'valid-active-token',
            refresh_token: '',
            token_type: 'Bearer',
          },
        },
      },
    });

    const result = Switcher.switchAccount(imported);
    expect(result.currentAccount.id).toBe(imported.id);
    expect(result.requiresShellUpdate).toBe(true);
    expect(writeSpy).toHaveBeenCalled();
  });

  it('normalizes missing refresh_token to empty string when stored via addOrUpdateAccount', () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'no-refresh@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'access-only',
          },
        } as unknown as import('../src/core/types.js').KeychainPayload,
      },
    });

    expect(acc.credentials?.keychainPayload?.token.refresh_token).toBe('');
    expect(acc.credentials?.keychainPayload?.token).toHaveProperty('refresh_token', '');

    const found = registry.findAccount('no-refresh@example.com');
    expect(found?.credentials?.keychainPayload?.token.refresh_token).toBe('');
    expect(found?.credentials?.keychainPayload?.token).toHaveProperty('refresh_token', '');
  });

  it('updates existing OAuth profile in place case-insensitively and retains refresh token', async () => {
    const registry = new RegistryManager();
    const existing = registry.addOrUpdateAccount({
      email: 'existing-user@example.com',
      alias: 'durable-alias',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'old-access-token',
            refresh_token: 'precious-refresh-token',
            token_type: 'Bearer',
            expiry: '2025-01-01T00:00:00.000Z',
          },
        },
      },
      gcpProject: 'existing-proj',
      gcpLocation: 'us-west1',
      model: 'gemini-1.5-pro',
      status: 'expired',
    });

    registry.setActiveAccount(existing.id);

    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'new-keychain-access-token',
          refresh_token: '',
          // Omitted refresh token in newly imported Keychain payload
          token_type: 'Bearer',
          expiry: '2030-01-01T00:00:00.000Z',
        },
      },
    });

    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({ email: 'EXISTING-USER@example.com', email_verified: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const result = await importKeychainOAuth({
      fetchFn: fetchFn as unknown as typeof fetch,
      registry,
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.isNew).toBe(false);
      expect(result.account.id).toBe(existing.id);
      expect(result.account.alias).toBe('durable-alias');
      expect(result.account.gcpProject).toBe('existing-proj');
      expect(result.account.gcpLocation).toBe('us-west1');
      expect(result.account.model).toBe('gemini-1.5-pro');
      expect(result.account.status).toBe('valid');
      expect(result.account.createdAt).toBe(existing.createdAt);
      expect(result.account.credentials?.keychainPayload?.token.access_token).toBe(
        'new-keychain-access-token'
      );
      expect(result.account.credentials?.keychainPayload?.token.refresh_token).toBe(
        'precious-refresh-token'
      );
    }

    // Verify active account pointer unchanged
    expect(registry.getActiveAccount()?.id).toBe(existing.id);
  });

  it('rejects invalid email address with UsageError', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'tok', refresh_token: '' },
      },
    });

    await expect(importKeychainOAuth({ email: 'not an email' })).rejects.toThrow(UsageError);
  });
});
