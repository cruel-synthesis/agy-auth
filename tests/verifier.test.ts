import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { Account } from '../src/core/types.js';
import { Verifier } from '../src/core/verifier.js';
import { VERSION } from '../src/version.js';
import { generateSyntheticPrivateKey, setupTestEnvironment, TestEnv } from './test-utils.js';

describe('Verifier module (Local and Remote API Key Checks)', () => {
  let testEnv: TestEnv;
  let testPrivateKey: string;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    testPrivateKey = generateSyntheticPrivateKey();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('verifies OAuth profiles locally without network requests', async () => {
    const validAccount: Account = {
      id: 'acc_oauth_valid',
      email: 'oauth@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'test-token',
            refresh_token: 'test-refresh',
            expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
          },
        },
      },
      status: 'unverified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await Verifier.verifyAccount(validAccount);
    expect(res.status).toBe('unverified');
    expect(res.verification?.source).toBe('local');

    // Expired token
    const expiredAccount: Account = {
      ...validAccount,
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'test-token',
            refresh_token: 'test-refresh',
            expiry: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
        },
      },
    };

    const resExpired = await Verifier.verifyAccount(expiredAccount);
    expect(resExpired.status).toBe('expired');

    // Missing token
    const missingAccount: Account = {
      ...validAccount,
      credentials: undefined,
    };
    const resMissing = await Verifier.verifyAccount(missingAccount);
    expect(resMissing.status).toBe('invalid');
  });

  it('verifies Service Account keys locally and checks email matching', async () => {
    const saAccount: Account = {
      id: 'acc_sa',
      email: 'sa@project.iam.gserviceaccount.com',
      authType: 'service-account',
      credentials: {
        serviceAccountKey: {
          type: 'service_account',
          project_id: 'project',
          private_key: testPrivateKey,
          client_email: 'sa@project.iam.gserviceaccount.com',
        },
      },
      status: 'unverified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await Verifier.verifyAccount(saAccount);
    expect(res.status).toBe('unverified');

    // Email mismatch
    const mismatchAccount: Account = {
      ...saAccount,
      email: 'different@example.com',
    };
    const resMismatch = await Verifier.verifyAccount(mismatchAccount);
    expect(resMismatch.status).toBe('invalid');
    expect(resMismatch.verification?.message).toContain('does not match');
  });

  it('verifies ADC credential profiles locally', async () => {
    const adcFile = path.join(testEnv.dir, 'adc-ver.json');
    fs.writeFileSync(
      adcFile,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'cs',
        refresh_token: 'tok',
      })
    );

    const adcAccount: Account = {
      id: 'acc_adc',
      email: 'adc@example.com',
      authType: 'adc',
      credentials: { adcPath: adcFile },
      status: 'unverified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await Verifier.verifyAccount(adcAccount);
    expect(res.status).toBe('unverified');
    expect(res.verification?.source).toBe('local');

    // Missing ADC file
    const missingAdc: Account = {
      ...adcAccount,
      credentials: { adcPath: path.join(testEnv.dir, 'nonexistent-adc.json') },
    };
    const resMissing = await Verifier.verifyAccount(missingAdc);
    expect(resMissing.status).toBe('invalid');
  });

  it('verifies API keys using headers and HTTP status mapping', async () => {
    const apiKeyAccount: Account = {
      id: 'acc_api_key',
      email: 'api@example.com',
      authType: 'api-key',
      credentials: {
        apiKey: 'test-api-key',
      },
      status: 'unverified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    let sentHeaders: Headers | undefined;
    const mock200 = (async (_url: string, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const res200 = await Verifier.verifyAccount(apiKeyAccount, { fetchFn: mock200 });
    expect(res200.status).toBe('valid');
    expect(sentHeaders?.get('x-goog-api-key')).toBe('test-api-key');
    expect(sentHeaders?.get('x-goog-api-client')).toBe(`agy-auth/${VERSION}`);

    // 429 Rate Limited -> rate-limited
    const mock429 = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const res429 = await Verifier.verifyAccount(apiKeyAccount, { fetchFn: mock429 });
    expect(res429.status).toBe('rate-limited');

    // 400/401 -> invalid
    const mock401 = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const res401 = await Verifier.verifyAccount(apiKeyAccount, { fetchFn: mock401 });
    expect(res401.status).toBe('invalid');

    // 403 Forbidden / Permission Denied -> unknown
    const mock403 = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    const res403 = await Verifier.verifyAccount(apiKeyAccount, { fetchFn: mock403 });
    expect(res403.status).toBe('unknown');

    // 500 / Network error -> unknown
    const mock500 = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    const res500 = await Verifier.verifyAccount(apiKeyAccount, { fetchFn: mock500 });
    expect(res500.status).toBe('unknown');

    // Fetch rejection
    const mockReject = (async () => {
      throw new Error('DNS failure');
    }) as unknown as typeof fetch;
    const resReject = await Verifier.verifyAccount(apiKeyAccount, { fetchFn: mockReject });
    expect(resReject.status).toBe('unknown');
  });

  it('handles unknown auth types gracefully', async () => {
    const unknownAccount = {
      id: 'acc_unk',
      email: 'unk@example.com',
      authType: 'custom-type' as unknown as Account['authType'],
      status: 'unverified' as const,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const res = await Verifier.verifyAccount(unknownAccount);
    expect(res.status).toBe('unknown');
  });

  it('does not mutate input account objects', async () => {
    const origAccount: Account = {
      id: 'acc_immutable',
      email: 'imm@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'key' },
      status: 'unverified',
      createdAt: 1000,
      updatedAt: 2000,
    };
    const cloned = JSON.parse(JSON.stringify(origAccount));

    const mock200 = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await Verifier.verifyAccount(origAccount, { fetchFn: mock200 });

    expect(origAccount).toEqual(cloned);
  });

  it('verifies multiple accounts as one bounded batch', async () => {
    const registry = new RegistryManager();
    const accounts: Account[] = Array.from({ length: 5 }, (_, i) =>
      registry.addOrUpdateAccount({
        email: `user${i}@example.com`,
        authType: 'api-key',
        credentials: { apiKey: `key_${i}` },
        status: 'unverified',
      })
    );

    const mockFetch = (async () => {
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const results = await Verifier.verifyAccounts(accounts, { fetchFn: mockFetch });
    expect(results.size).toBe(5);

    for (const result of results.values()) {
      expect(result.status).toBe('valid');
      expect(result.verification.source).toBe('remote');
    }
  });
});
