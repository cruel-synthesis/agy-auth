import fs from 'node:fs';
import path from 'node:path';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { QUOTA_CACHE_TTL_MS } from '../src/commands/refresh.js';
import { QuotaClient, QuotaRefresh } from '../src/core/quota.js';
import { Account } from '../src/core/types.js';
import { colors } from '../src/ui/theme.js';
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

  it('sends the watcher to the measured account, not the one with the best guess', async () => {
    // acc1 answers and is spent, acc2 reports only a 5-hour window, acc3 reports
    // both. acc2's unread week is scored as an untouched one, which puts it on
    // top; that guess must not be what the watcher moves the session to.
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        activeAccountId: 'acc1',
        previousAccountId: null,
        accounts: [account('acc1', 0.8), account('acc2', 0.95), account('acc3', 0.99)],
        settings: { defaultLocation: 'global' },
      })}\n`,
      { mode: 0o600 }
    );
    const readings: Record<string, Account['rateLimit']> = {
      acc1: {
        gemini: { rate5h: { usedPercent: 99, windowMinutes: 300, resetsAt: NOW_SEC + 3600 } },
      },
      acc2: {
        gemini: { rate5h: { usedPercent: 5, windowMinutes: 300, resetsAt: NOW_SEC + 3600 } },
      },
      acc3: {
        gemini: {
          rate5h: { usedPercent: 1, windowMinutes: 300, resetsAt: NOW_SEC + 3600 },
          rateWeekly: { usedPercent: 70, windowMinutes: 10_080, resetsAt: NOW_SEC + 604_800 },
        },
      },
    };
    vi.spyOn(QuotaClient, 'refreshAccountQuotas').mockImplementation(async (accounts) => {
      const results = new Map<string, QuotaRefresh>();
      for (const target of accounts) {
        results.set(target.id, {
          result: {
            accountId: target.id,
            observedUpdatedAt: target.updatedAt,
            ok: true,
            status: 'valid',
            quotaCheckedAt: Date.now(),
            rateLimit: readings[target.id],
          },
        });
      }
      return results;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const watching = autoCommand({ json: true, dryRun: true, watch: true, interval: '1' });
    process.emit('SIGINT');
    await expect(watching).rejects.toThrow(/Stopped watching/);

    const tick = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(tick.data.event).toBe('would-switch');
    expect(tick.data.chosenAccountId).toBe('acc3');
  });

  it('does not call an unread account spent alongside an exhausted one', async () => {
    // acc1 was read and is out; acc2 was never read. Nothing is known to be
    // usable, but only acc1 is known to be spent.
    const spent = account('acc1', 0.01);
    const unread: Account = { ...account('acc2', 0.5), rateLimit: undefined };
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        activeAccountId: 'acc1',
        previousAccountId: null,
        accounts: [spent, unread],
        settings: { defaultLocation: 'global' },
      })}\n`,
      { mode: 0o600 }
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(autoCommand({ dryRun: true, offline: true })).rejects.toThrow(
      /No account has known usable quota: 1 out of quota, 1 not read\. Of those out of quota, the first frees up in/
    );
    await expect(autoCommand({ dryRun: true, offline: true })).rejects.not.toThrow(
      /Every account is out/
    );
  });

  it('names why each account is out rather than calling it unread', async () => {
    const write = (accounts: Account[]) =>
      fs.writeFileSync(
        path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
        `${JSON.stringify({
          schemaVersion: 3,
          activeAccountId: 'acc1',
          previousAccountId: null,
          accounts,
          settings: { defaultLocation: 'global' },
        })}\n`,
        { mode: 0o600 }
      );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // A rejected sign-in is not a missing reading: a check cannot fix it.
    write([
      { ...account('acc1', 0.9), status: 'needs-reauth' },
      { ...account('acc2', 0.9), status: 'expired' },
    ]);
    await expect(autoCommand({ dryRun: true, offline: true })).rejects.toThrow(
      /^Every account needs a fresh sign-in\. Sign in through Antigravity/
    );

    // 5-hour room with a spent week is out until the week resets, not the window.
    const spentWeek = (id: string): Account => {
      const entry = account(id, 0.9);
      if (entry.rateLimit?.gemini?.rateWeekly) entry.rateLimit.gemini.rateWeekly.usedPercent = 100;
      return entry;
    };
    write([spentWeek('acc1'), spentWeek('acc2')]);
    await expect(autoCommand({ dryRun: true, offline: true })).rejects.toThrow(
      /^Every account is out of weekly quota\. The first frees up in 1d 0h\.$/
    );

    // An API-key account is never read, and saying so is not a reason to check.
    write([
      account('acc1', 0.01),
      {
        id: 'acc2',
        email: 'acc2@example.com',
        authType: 'api-key',
        status: 'valid',
        credentials: { apiKey: 'synthetic-key' },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    await expect(autoCommand({ dryRun: true, offline: true })).rejects.toThrow(
      /^No account has known usable quota: 1 out of quota, 1 not OAuth\. Of those out of quota, the first frees up in 1h 0m\.$/
    );
  });

  it('leaves a non-OAuth account in use alone while watching', async () => {
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        activeAccountId: 'key',
        previousAccountId: null,
        accounts: [
          {
            id: 'key',
            email: 'key@example.com',
            authType: 'api-key',
            status: 'valid',
            credentials: { apiKey: 'synthetic-key' },
            createdAt: NOW,
            updatedAt: NOW,
          },
          account('acc2', 0.9),
        ],
        settings: { defaultLocation: 'global' },
      })}\n`,
      { mode: 0o600 }
    );
    const refreshSpy = vi.spyOn(QuotaClient, 'refreshAccountQuotas');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const watching = autoCommand({ json: true, dryRun: true, watch: true, interval: '1' });
    process.emit('SIGINT');
    await expect(watching).rejects.toThrow(/Stopped watching/);

    const tick = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(tick.data.event).toBe('idle');
    expect(tick.data.chosenAccountId).toBeUndefined();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('stays on the account in use when its reading has no 5-hour window', async () => {
    const asked: string[] = [];
    vi.spyOn(QuotaClient, 'refreshAccountQuotas').mockImplementation(async (accounts) => {
      const results = new Map<string, QuotaRefresh>();
      for (const target of accounts) {
        asked.push(target.id);
        results.set(target.id, {
          result: {
            accountId: target.id,
            observedUpdatedAt: target.updatedAt,
            ok: true,
            status: 'valid',
            quotaCheckedAt: Date.now(),
            rateLimit: {
              gemini: {
                rateWeekly: { usedPercent: 50, windowMinutes: 10_080, resetsAt: NOW_SEC + 86_400 },
              },
            },
          },
        });
      }
      return results;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const watching = autoCommand({ json: true, dryRun: true, watch: true, interval: '1' });
    process.emit('SIGINT');
    await expect(watching).rejects.toThrow(/Stopped watching/);

    const tick = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(tick.data.event).toBe('holding');
    expect(tick.data.detail).toContain('no current quota reading');
    expect(asked).toEqual([tick.data.activeAccountId]);
  });

  it('does not ask about an account already known to need a sign-in', async () => {
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        activeAccountId: 'acc1',
        previousAccountId: null,
        accounts: [
          account('acc1', 0.2),
          { ...account('acc2', 0.9), status: 'needs-reauth' },
          account('acc3', 0.9),
        ],
        settings: { defaultLocation: 'global' },
      })}\n`,
      { mode: 0o600 }
    );
    const asked: string[] = [];
    vi.spyOn(QuotaClient, 'refreshAccountQuotas').mockImplementation(async (accounts) => {
      const results = new Map<string, QuotaRefresh>();
      for (const target of accounts) {
        asked.push(target.id);
        results.set(
          target.id,
          target.id === 'acc2'
            ? {
                result: {
                  accountId: target.id,
                  observedUpdatedAt: target.updatedAt,
                  ok: false,
                  reason: 'auth-failed',
                },
              }
            : {
                result: {
                  accountId: target.id,
                  observedUpdatedAt: target.updatedAt,
                  ok: true,
                  status: 'valid',
                  quotaCheckedAt: Date.now(),
                  rateLimit: {
                    gemini: {
                      rate5h: {
                        usedPercent: target.id === 'acc1' ? 99 : 10,
                        windowMinutes: 300,
                        resetsAt: NOW_SEC + 3600,
                      },
                      rateWeekly: {
                        usedPercent: 50,
                        windowMinutes: 10_080,
                        resetsAt: NOW_SEC + 86_400,
                      },
                    },
                  },
                },
              }
        );
      }
      return results;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const watching = autoCommand({ json: true, dryRun: true, watch: true, interval: '1' });
    process.emit('SIGINT');
    await expect(watching).rejects.toThrow(/Stopped watching/);

    const tick = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(tick.data.chosenAccountId).toBe('acc3');
    expect(asked).not.toContain('acc2');
    expect(tick.data.detail).not.toMatch(/could not refresh/);
  });

  it("does not credit the account kept in use with the leader's reasons", async () => {
    // acc2 ranks first, but only just, so the session stays on acc1.
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        activeAccountId: 'acc1',
        previousAccountId: null,
        accounts: [account('acc1', 0.9), account('acc2', 0.92)],
        settings: { defaultLocation: 'global' },
      })}\n`,
      { mode: 0o600 }
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await autoCommand({ dryRun: true, offline: true });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');

    expect(output).toMatch(/Staying on acc1@example\.com\./);
    expect(output).toMatch(/acc2@example\.com ranks first, but not by enough/);
    expect(output).not.toMatch(/most likely to go to waste/);
  });

  it('ends the dimmed ranking header even when it has to be clipped', async () => {
    vi.spyOn(colors, 'dim').mockImplementation((text: string) => `\x1b[2m${text}\x1b[22m`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalColumns = process.env.COLUMNS;
    process.env.COLUMNS = '8';

    try {
      await autoCommand({ dryRun: true, offline: true });
      const header = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('ACC'));

      expect(header?.endsWith('\x1b[22m')).toBe(true);
      expect(stringWidth(header ?? '')).toBe(8);
    } finally {
      process.env.COLUMNS = originalColumns;
    }
  });

  it('drops the last column rather than cut digits from it', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalColumns = process.env.COLUMNS;

    try {
      for (const columns of ['16', '17', '18', '19']) {
        logSpy.mockClear();
        process.env.COLUMNS = columns;
        await autoCommand({ dryRun: true, offline: true });
        const lines = logSpy.mock.calls.map((call) => String(call[0]));
        const header = lines.findIndex((line) => line.includes('ACC'));
        const rows = lines.slice(header + 1, header + 3);

        expect(rows).toHaveLength(2);
        for (const row of rows) expect(row).not.toMatch(/\d$/);
      }
    } finally {
      process.env.COLUMNS = originalColumns;
    }
  });
});
