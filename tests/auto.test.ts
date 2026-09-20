import fs from 'node:fs';
import path from 'node:path';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { QUOTA_CACHE_TTL_MS } from '../src/commands/refresh.js';
import { QuotaClient, QuotaRefresh } from '../src/core/quota.js';
import { Account } from '../src/core/types.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

const NOW = Date.now();
const NOW_SEC = Math.floor(NOW / 1000);

function account(id: string, remaining5h: number): Account {
  return {
    id,
    email: `${id}@example.com`,
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
    // Aged past the TTL, so an ordinary run tries to renew it and fails.
    quotaCheckedAt: NOW - QUOTA_CACHE_TTL_MS - 1,
    rateLimit: {
      gemini: {
        rate5h: {
          usedPercent: 100 - remaining5h * 100,
          windowMinutes: 300,
          resetsAt: NOW_SEC + 3600,
        },
        rateWeekly: { usedPercent: 50, windowMinutes: 10_080, resetsAt: NOW_SEC + 86_400 },
      },
    },
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
  };
}

describe('Automatic switching', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        activeAccountId: 'acc1',
        previousAccountId: null,
        accounts: [account('acc1', 0.2), account('acc2', 0.9)],
        settings: { defaultLocation: 'global' },
      })}\n`,
      { mode: 0o600 }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('fits its ranking into a narrow terminal without clipping a number', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalColumns = process.env.COLUMNS;
    process.env.COLUMNS = '40';

    try {
      await autoCommand({ dryRun: true, offline: true });
      const table = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('ACCOUNT') || line.includes('@example.com'));

      expect(table.length).toBeGreaterThan(0);
      for (const line of table) {
        expect(stringWidth(line)).toBeLessThanOrEqual(40);
      }
      // The score cannot fit, and a clipped score would read as a real one.
      expect(table[0]).not.toContain('SCORE');
      expect(table[0]).toContain('5H');
    } finally {
      process.env.COLUMNS = originalColumns;
      logSpy.mockRestore();
    }
  });

  it('says so when it had to decide on readings it could not renew', async () => {
    vi.spyOn(QuotaClient, 'refreshAccountQuotas').mockImplementation(async (accounts) => {
      const results = new Map<string, QuotaRefresh>();
      for (const target of accounts) {
        results.set(target.id, {
          result: {
            accountId: target.id,
            observedUpdatedAt: target.updatedAt,
            ok: false,
            reason: 'network-error',
          },
        });
      }
      return results;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await autoCommand({ json: true, dryRun: true });

    const envelope = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(envelope.data.chosenAccountId).toBe('acc2');
    expect(envelope.data.switched).toBe(false);
    expect(envelope.data.warnings).toHaveLength(1);
    expect(envelope.data.warnings[0]).toMatch(/could not refresh live quota for 2 of 2 accounts/);
  });

  it('carries a failed reading of the other accounts into the switch it decides', async () => {
    // The account in use answers and turns out to be spent; the others cannot be
    // renewed, so the move is decided on what was already on hand and says so.
    vi.spyOn(QuotaClient, 'refreshAccountQuotas').mockImplementation(async (accounts) => {
      const results = new Map<string, QuotaRefresh>();
      for (const target of accounts) {
        results.set(
          target.id,
          target.id === 'acc1'
            ? {
                result: {
                  accountId: target.id,
                  observedUpdatedAt: target.updatedAt,
                  ok: true,
                  status: 'valid',
                  quotaCheckedAt: Date.now(),
                  rateLimit: {
                    gemini: {
                      rate5h: { usedPercent: 97, windowMinutes: 300, resetsAt: NOW_SEC + 3600 },
                    },
                  },
                },
              }
            : {
                result: {
                  accountId: target.id,
                  observedUpdatedAt: target.updatedAt,
                  ok: false,
                  reason: 'network-error',
                },
              }
        );
      }
      return results;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // One check, then Ctrl-C: the watcher runs until it is interrupted.
    const watching = autoCommand({ json: true, dryRun: true, watch: true, interval: '1' });
    process.emit('SIGINT');
    await expect(watching).rejects.toThrow(/Stopped watching/);

    const tick = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(tick.data.event).toBe('would-switch');
    expect(tick.data.chosenAccountId).toBe('acc2');
    expect(tick.data.detail).toMatch(/would switch to acc2@example.com/);
    expect(tick.data.detail).toMatch(/could not refresh live quota for acc2@example.com/);
  });

  it('says the quota is unknown, not spent, when nothing could be read', async () => {
    // No cached readings and no live ones either: the app knows nothing about
    // these accounts, which is not the same as knowing they are out.
    const unread = (id: string): Partial<Account> => {
      const withReadings: Partial<Account> = account(id, 0.5);
      withReadings.rateLimit = undefined;
      return withReadings;
    };
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        activeAccountId: 'acc1',
        previousAccountId: null,
        accounts: [unread('acc1'), unread('acc2')],
        settings: { defaultLocation: 'global' },
      })}\n`,
      { mode: 0o600 }
    );
    vi.spyOn(QuotaClient, 'refreshAccountQuotas').mockImplementation(async (accounts) => {
      const results = new Map<string, QuotaRefresh>();
      for (const target of accounts) {
        results.set(target.id, {
          result: {
            accountId: target.id,
            observedUpdatedAt: target.updatedAt,
            ok: false,
            reason: 'network-error',
          },
        });
      }
      return results;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(autoCommand({ dryRun: true })).rejects.toThrow(
      /Quota could not be determined for any account/
    );
    // The reason the readings are missing belongs with the refusal, not only
    // with the runs that end in a choice.
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /could not refresh live quota for 2 of 2 accounts/
    );

    await expect(autoCommand({ dryRun: true, json: true })).rejects.toMatchObject({
      details: { warnings: [expect.stringMatching(/could not refresh live quota/)] },
    });
  });

  it('reports no warning when every reading is current', async () => {
    const refreshSpy = vi.spyOn(QuotaClient, 'refreshAccountQuotas');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await autoCommand({ json: true, dryRun: true, offline: true });

    expect(refreshSpy).not.toHaveBeenCalled();
    const envelope = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(envelope.data.warnings).toBeUndefined();
    expect(envelope.data.chosenAccountId).toBe('acc2');
  });
});
