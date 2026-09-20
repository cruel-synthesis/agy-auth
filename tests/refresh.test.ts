import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUOTA_CACHE_TTL_MS,
  refreshQuota,
  selectRefreshable,
  selectStale,
} from '../src/commands/refresh.js';
import { applyQuotaResults } from '../src/core/quota-apply.js';
import { QuotaClient, QuotaRefresh } from '../src/core/quota.js';
import { RegistryManager } from '../src/core/registry.js';
import { Account } from '../src/core/types.js';
import { setupTestEnvironment, TestEnv } from './test-utils.js';

const NOW = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);

function oauthAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc1',
    email: 'user@example.com',
    authType: 'oauth',
    status: 'valid',
    credentialSource: 'antigravity',
    credentials: {
      keychainPayload: {
        auth_method: 'consumer',
        token: {
          access_token: 'synthetic-access-token',
          refresh_token: 'synthetic-refresh-token',
          token_type: 'Bearer',
          expiry: new Date(NOW + 3_600_000).toISOString(),
        },
      },
    },
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    ...overrides,
  };
}

/** A reading taken a minute ago, well inside the cache TTL. */
function freshCache(resetsAt: number) {
  return {
    quotaCheckedAt: NOW - 60_000,
    rateLimit: { gemini: { rate5h: { usedPercent: 40, windowMinutes: 300, resetsAt } } },
  };
}

describe('Quota refresh selection', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('leaves a reading alone while it is inside the TTL and its window is still open', () => {
    const account = oauthAccount(freshCache(NOW_SEC + 3600));
    expect(selectStale([account])).toEqual([]);
  });

  it('refreshes a window that has outlived its own reset time, TTL notwithstanding', () => {
    // Checked one minute ago, but the 5-hour window it described ended a minute
    // ago: the number on screen is no longer a reading of anything.
    const account = oauthAccount(freshCache(NOW_SEC - 60));
    expect(selectStale([account]).map((a) => a.id)).toEqual(['acc1']);
  });

  it('refreshes a reading that has aged past the cache TTL', () => {
    const account = oauthAccount({
      quotaCheckedAt: NOW - QUOTA_CACHE_TTL_MS - 1,
      rateLimit: {
        gemini: { rate5h: { usedPercent: 40, windowMinutes: 300, resetsAt: NOW_SEC + 3600 } },
      },
    });
    expect(selectStale([account]).map((a) => a.id)).toEqual(['acc1']);

    // A reading that was never taken is stale by the same rule.
    expect(selectStale([oauthAccount({ quotaCheckedAt: undefined })]).map((a) => a.id)).toEqual([
      'acc1',
    ]);
  });

  it('spends no round trip on accounts that cannot answer', () => {
    // An account that must be signed in again would fail every time.
    const signedOut = oauthAccount({ id: 'acc_out', status: 'needs-reauth', ...freshCache(1) });
    // Live quota is an OAuth concept; an API key is never contacted.
    const apiKey = oauthAccount({
      id: 'acc_key',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSySynthetic' },
      ...freshCache(1),
    });

    expect(selectStale([signedOut, apiKey])).toEqual([]);
    expect(selectRefreshable([signedOut, apiKey]).map((a) => a.id)).toEqual(['acc_out']);
  });
});

describe('Quota refresh outcomes', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('contacts nothing in offline mode', async () => {
    const refreshSpy = vi.spyOn(QuotaClient, 'refreshAccountQuotas');

    const outcome = await refreshQuota([oauthAccount()], true);

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(outcome.refreshes).toEqual([]);
    expect(outcome.warning).toBeUndefined();
    expect(outcome.summary).toEqual({ attempted: false, offline: true, accounts: [] });
  });

  it('reports a failed refresh instead of presenting it as a reading', async () => {
    const account = oauthAccount({ alias: 'work' });
    vi.spyOn(QuotaClient, 'refreshAccountQuotas').mockResolvedValue(
      new Map<string, QuotaRefresh>([
        [
          account.id,
          {
            result: {
              accountId: account.id,
              observedUpdatedAt: account.updatedAt,
              ok: false,
              reason: 'network-error',
            },
          },
        ],
      ])
    );

    const outcome = await refreshQuota([account], false);

    expect(outcome.summary.attempted).toBe(true);
    expect(outcome.summary.accounts).toEqual([
      { accountId: account.id, ok: false, reason: 'network-error' },
    ]);
    expect(outcome.warning).toMatch(/could not refresh live quota for work/);
    expect(outcome.warning).toMatch(/network or service error/);
    expect(outcome.warning).toMatch(/Showing cached quota where available/);
  });

  it('does not let a failed refresh pass the cached reading off as current', async () => {
    const cached = {
      quotaCheckedAt: NOW - QUOTA_CACHE_TTL_MS - 1,
      rateLimit: {
        gemini: { rate5h: { usedPercent: 40, windowMinutes: 300, resetsAt: NOW_SEC - 60 } },
      },
    };
    const account = oauthAccount(cached);
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify(
        {
          schemaVersion: 3,
          activeAccountId: account.id,
          previousAccountId: null,
          accounts: [account],
          settings: { defaultLocation: 'global' },
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    const registry = new RegistryManager();
    const applied = await applyQuotaResults(registry, [
      {
        result: {
          accountId: account.id,
          observedUpdatedAt: account.updatedAt,
          ok: false,
          reason: 'network-error',
        },
      },
    ]);

    expect(applied).toBe(0);
    const [stored] = new RegistryManager().getAccounts();
    expect(stored.quotaCheckedAt).toBe(cached.quotaCheckedAt);
    expect(stored.updatedAt).toBe(account.updatedAt);
    // Still stale, so the next read tries again rather than trusting this.
    expect(selectStale([stored]).map((a) => a.id)).toEqual([account.id]);
  });
});
