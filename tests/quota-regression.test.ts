import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Account, Registry } from '../src/core/types.js';
import { renderAccountsTable } from '../src/ui/table.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

/**
 * Permanent guard against the simplified rewrite that silently dropped live plan
 * and quota reporting. Every assertion here fails on an implementation without
 * plan/quota support, so the feature cannot disappear again unnoticed.
 */
describe('Plan and quota support regression guard', () => {
  let testEnv: TestEnv;
  const cliPath = path.resolve('bin/agy-auth.js');

  const cachedQuotaAccount = (): Account => ({
    id: 'quota1',
    email: 'quota@example.com',
    alias: 'quota-user',
    authType: 'oauth',
    status: 'valid',
    plan: 'Google AI Ultra',
    rateLimit: {
      gemini: {
        rate5h: { usedPercent: 25, windowMinutes: 300, resetsAt: 4_102_444_800 },
        rateWeekly: { usedPercent: 60, windowMinutes: 10080, resetsAt: 4_102_444_800 },
      },
      claude: {
        rate5h: { usedPercent: 10, windowMinutes: 300, resetsAt: 4_102_444_800 },
        rateWeekly: { usedPercent: 90, windowMinutes: 10080, resetsAt: 4_102_444_800 },
      },
    },
    quotaCheckedAt: Date.now() - 120_000,
    credentials: {
      keychainPayload: {
        auth_method: 'consumer',
        token: {
          access_token: 'synthetic-access-token',
          refresh_token: 'synthetic-refresh-token',
          token_type: 'Bearer',
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    },
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 86_400_000,
    lastUsedAt: Date.now() - 60_000,
  });

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('renders the seven-column plan and quota table', () => {
    const table = renderAccountsTable([cachedQuotaAccount()], 'quota1', 140);
    for (const header of [
      'ACCOUNT',
      'PLAN',
      'GEMINI 5H',
      'GEMINI WK',
      'CLAUDE 5H',
      'CLAUDE WK',
      'LAST',
    ]) {
      expect(table).toContain(header);
    }
  });

  it('renders cached plan and remaining quota percentages in account rows', () => {
    const table = renderAccountsTable([cachedQuotaAccount()], 'quota1', 140);
    expect(table).toContain('Ultra');
    // Remaining percentages derived from usedPercent 25/60/10/90.
    expect(table).toContain('75%');
    expect(table).toContain('40%');
    expect(table).toContain('90%');
    expect(table).toContain('10%');
  });

  it('exposes a quota client that refreshes plan and quota from injected transport', async () => {
    const quota = await import('../src/core/quota.js');
    expect(typeof quota.QuotaClient?.refreshAccountQuota).toBe('function');

    const account: Account = { ...cachedQuotaAccount(), plan: undefined, rateLimit: undefined };
    const fetchFn = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('retrieveUserQuotaSummary')) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: 'Gemini',
                buckets: [
                  { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4 },
                  { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8 },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (target.includes('loadCodeAssist')) {
        return new Response(
          JSON.stringify({
            currentTier: { name: 'Google AI Pro' },
            cloudaicompanionProject: 'p-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const { result } = await quota.QuotaClient.refreshAccountQuota(account, { fetchFn });
    expect(result.ok).toBe(true);
    expect(result.plan).toBe('Google AI Pro');
    expect(result.rateLimit?.gemini?.rate5h?.usedPercent).toBe(60);
    expect(result.rateLimit?.gemini?.rateWeekly?.usedPercent).toBe(20);
    expect(result.quotaCheckedAt).toBeGreaterThan(0);
  });

  it('renders cached quota through the packaged CLI bundle', () => {
    const registry: Registry = {
      schemaVersion: 2,
      activeAccountId: 'quota1',
      previousAccountId: null,
      accounts: [cachedQuotaAccount()],
      settings: { defaultLocation: 'global' },
    };
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify(registry, null, 2)}\n`,
      { mode: 0o600 }
    );

    const stdout = execFileSync('node', [cliPath, 'list', '--offline'], {
      encoding: 'utf-8',
      env: { ...testEnv.createSubprocessEnv(), NO_COLOR: '1', COLUMNS: '140' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(stdout).toContain('GEMINI 5H');
    expect(stdout).toContain('CLAUDE WK');
    expect(stdout).toContain('Ultra');
    expect(stdout).toContain('75%');
  });
});
