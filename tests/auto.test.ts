import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { QUOTA_CACHE_TTL_MS } from '../src/commands/refresh.js';
import { QuotaClient, QuotaRefresh } from '../src/core/quota.js';
import { Account } from '../src/core/types.js';
import { setupTestEnvironment, TestEnv } from './test-utils.js';

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
