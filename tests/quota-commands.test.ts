import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentCommand } from '../src/commands/current.js';
import { detailsCommand } from '../src/commands/details.js';
import { importCommand } from '../src/commands/import.js';
import { listCommand } from '../src/commands/list.js';
import { switchCommand } from '../src/commands/switch.js';
import { UsageError } from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { QuotaOptions } from '../src/core/quota.js';
import { RegistryManager } from '../src/core/registry.js';
import { Account, Registry } from '../src/core/types.js';
import { getTableComponents, renderAccountsTable, renderSelectMenu } from '../src/ui/table.js';
import { installNativeStoreDouble, TestEnv, setupTestEnvironment } from './test-utils.js';

const FUTURE_RESET = 4_102_444_800;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function quotaFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('retrieveUserQuotaSummary')) {
      return jsonResponse({
        groups: [
          {
            displayName: 'Gemini',
            buckets: [
              {
                bucketId: 'gemini-5h',
                window: '5h',
                remainingFraction: 0.35,
                resetTime: '2100-01-01T00:00:00Z',
              },
            ],
          },
        ],
      });
    }
    if (url.includes('loadCodeAssist')) {
      return jsonResponse({ paidTier: { name: 'Google AI Ultra' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

function oauthAccount(overrides: Partial<Account> = {}): Account {
  const now = Date.now();
  return {
    id: 'oauth1',
    email: 'oauth@example.com',
    alias: 'primary',
    authType: 'oauth',
    status: 'valid',
    gcpProject: 'user-project',
    credentials: {
      keychainPayload: {
        auth_method: 'consumer',
        token: {
          access_token: 'synthetic-access-token',
          refresh_token: 'synthetic-refresh-token',
          token_type: 'Bearer',
          expiry: new Date(now + 3_600_000).toISOString(),
        },
      },
    },
    createdAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastUsedAt: now - 60_000,
    ...overrides,
  };
}

describe('Plan and quota command behaviour', () => {
  let testEnv: TestEnv;
  let output: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  function seed(accounts: Account[], activeAccountId: string | null = accounts[0]?.id ?? null) {
    const registry: Registry = {
      schemaVersion: 3,
      activeAccountId,
      previousAccountId: null,
      accounts,
      settings: { defaultLocation: 'global' },
    };
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify(registry, null, 2)}\n`,
      { mode: 0o600 }
    );
  }

  const stdout = () => output.join('\n');

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    process.env.COLUMNS = '160';
    output = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('rejects the contradictory combination of --check and --offline', async () => {
    seed([oauthAccount()]);
    await expect(listCommand({ check: true, offline: true })).rejects.toThrow(UsageError);
    await expect(listCommand({ check: true, offline: true })).rejects.toThrow(/--offline/);
  });

  it('makes no network request in offline mode', async () => {
    seed([oauthAccount()]);
    const calls: string[] = [];
    const quotaOptions: QuotaOptions = { fetchFn: quotaFetch(calls) };

    await listCommand({ offline: true, json: true, quotaOptions });
    await currentCommand({ offline: true, json: true, quotaOptions });
    await detailsCommand('primary', { offline: true, json: true, quotaOptions });

    expect(calls).toHaveLength(0);
    for (const payload of output.map((line) => JSON.parse(line))) {
      expect(payload.data.quotaRefresh).toEqual({ attempted: false, offline: true, accounts: [] });
    }
  });

  it('refreshes only the active OAuth profile for a default list', async () => {
    const active = oauthAccount();
    const other = oauthAccount({
      id: 'oauth2',
      email: 'other@example.com',
      alias: 'secondary',
      updatedAt: Date.now() - 86_400_000,
    });
    seed([active, other], 'oauth1');

    const calls: string[] = [];
    await listCommand({ json: true, quotaOptions: { fetchFn: quotaFetch(calls) } });

    const payload = JSON.parse(stdout());
    expect(payload.data.quotaRefresh.attempted).toBe(true);
    expect(payload.data.quotaRefresh.accounts).toEqual([{ accountId: 'oauth1', ok: true }]);

    const stored = new RegistryManager().getAccounts();
    expect(stored.find((a) => a.id === 'oauth1')?.plan).toBe('Google AI Ultra');
    expect(stored.find((a) => a.id === 'oauth1')?.rateLimit?.gemini?.rate5h?.usedPercent).toBe(65);
    expect(stored.find((a) => a.id === 'oauth2')?.plan).toBeUndefined();
    expect(stored.find((a) => a.id === 'oauth2')?.quotaCheckedAt).toBeUndefined();
  });

  it('refreshes every selected OAuth profile for list --check and skips other auth types', async () => {
    const apiKey: Account = {
      id: 'api1',
      email: 'api@example.com',
      authType: 'api-key',
      status: 'unverified',
      credentials: { apiKey: 'synthetic-api-key' },
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    };
    seed(
      [
        oauthAccount(),
        oauthAccount({ id: 'oauth2', email: 'other@example.com', alias: 'second' }),
        apiKey,
      ],
      'oauth1'
    );

    const calls: string[] = [];
    await listCommand({
      check: true,
      json: true,
      quotaOptions: { fetchFn: quotaFetch(calls) },
    });

    const payload = JSON.parse(stdout());
    expect(
      payload.data.quotaRefresh.accounts.map((a: { accountId: string }) => a.accountId)
    ).toEqual(['oauth1', 'oauth2']);

    const stored = new RegistryManager().getAccounts();
    expect(stored.find((a) => a.id === 'oauth2')?.plan).toBe('Google AI Ultra');
    // The API key profile is verified locally as invalid-free but never quota-probed.
    expect(stored.find((a) => a.id === 'api1')?.quotaCheckedAt).toBeUndefined();
  });

  it('warns once in human mode and still renders cached data on refresh failure', async () => {
    seed([
      oauthAccount({
        plan: 'Google AI Ultra',
        rateLimit: {
          gemini: { rate5h: { usedPercent: 20, windowMinutes: 300, resetsAt: FUTURE_RESET } },
        },
        quotaCheckedAt: Date.now() - 300_000,
      }),
    ]);

    const failingFetch = (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await listCommand({ quotaOptions: { fetchFn: failingFetch } });

    const text = stdout();
    const warnings = text.split('\n').filter((line) => line.includes('Warning:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('network or service error');
    expect(text).toContain('GEMINI 5H');
    expect(text).toContain('80%');
    expect(text).toContain('Ultra');
  });

  it('reports a recovery path for expired tokens without a configured client id', async () => {
    seed([
      oauthAccount({
        credentials: {
          keychainPayload: {
            auth_method: 'consumer',
            token: {
              access_token: 'stale-access-token',
              refresh_token: 'synthetic-refresh-token',
              token_type: 'Bearer',
              expiry: new Date(Date.now() - 3_600_000).toISOString(),
            },
          },
        },
      }),
    ]);

    const calls: string[] = [];
    await listCommand({ quotaOptions: { fetchFn: quotaFetch(calls), env: {} } });

    expect(calls).toHaveLength(0);
    const text = stdout();
    expect(text).toContain('agy-auth sync');
    expect(text).toContain('Antigravity');
    expect(new RegistryManager().getAccounts()[0].status).toBe('expired');
  });

  it('renders plan and quota in current and details, human and JSON', async () => {
    seed([oauthAccount()]);
    const quotaOptions: QuotaOptions = { fetchFn: quotaFetch() };

    await currentCommand({ quotaOptions });
    let text = stdout();
    expect(text).toContain('Plan:');
    expect(text).toContain('Google AI Ultra');
    expect(text).toContain('Gemini 5h:');
    expect(text).toContain('35% remaining');
    expect(text).toContain('Quota check:');

    output = [];
    await detailsCommand('primary', { quotaOptions });
    text = stdout();
    expect(text).toContain('Plan:');
    expect(text).toContain('Gemini week:  -');

    output = [];
    await currentCommand({ json: true, quotaOptions });
    const currentPayload = JSON.parse(stdout());
    expect(currentPayload.data.account.plan).toBe('Google AI Ultra');
    expect(currentPayload.data.account.rateLimit.gemini.rate5h.usedPercent).toBe(65);
    expect(currentPayload.data.account.quotaCheckedAt).toBeGreaterThan(0);
    expect(currentPayload.data.account.credentials).toBeUndefined();
    expect(currentPayload.data.quotaRefresh.attempted).toBe(true);

    output = [];
    await detailsCommand('primary', { json: true, quotaOptions });
    const detailsPayload = JSON.parse(stdout());
    expect(detailsPayload.data.account.plan).toBe('Google AI Ultra');
    expect(detailsPayload.data.account.credentials).toBeUndefined();
    expect(detailsPayload.data.quotaRefresh.offline).toBe(false);
  });

  it('never leaks credentials through a JSON envelope carrying quota data', async () => {
    seed([oauthAccount()]);
    await listCommand({ json: true, quotaOptions: { fetchFn: quotaFetch() } });
    const raw = stdout();
    expect(raw).not.toContain('synthetic-access-token');
    expect(raw).not.toContain('synthetic-refresh-token');
    expect(JSON.parse(raw).data.accounts[0].credentials).toBeUndefined();
  });

  it('switches from cached data with no network request and no quota rewrite', async () => {
    const account = oauthAccount({
      plan: 'Google AI Ultra',
      rateLimit: {
        gemini: { rate5h: { usedPercent: 20, windowMinutes: 300, resetsAt: FUTURE_RESET } },
      },
      quotaCheckedAt: 1_700_000_000_000,
    });
    const second = oauthAccount({ id: 'oauth2', email: 'other@example.com', alias: 'second' });
    seed([account, second], 'oauth2');

    const nativeStore = installNativeStoreDouble();
    try {
      await switchCommand('primary', { json: true });

      const stored = new RegistryManager().getAccounts().find((a) => a.id === 'oauth1');
      expect(stored?.plan).toBe('Google AI Ultra');
      expect(stored?.quotaCheckedAt).toBe(1_700_000_000_000);
      // Switching applies stored credentials to external state; quota refresh does not.
      expect(nativeStore.stored).not.toBeNull();
    } finally {
      nativeStore.restore();
    }
  });

  it('does not touch the Keychain during a quota refresh that rotates a token', async () => {
    seed([
      oauthAccount({
        credentials: {
          keychainPayload: {
            auth_method: 'consumer',
            token: {
              access_token: 'stale-access-token',
              refresh_token: 'synthetic-refresh-token',
              token_type: 'Bearer',
              expiry: new Date(Date.now() - 3_600_000).toISOString(),
            },
          },
        },
      }),
    ]);

    const writeSpy = vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValue(true);
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) {
        return jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 });
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return jsonResponse({
          groups: [
            {
              displayName: 'Gemini',
              buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5 }],
            },
          ],
        });
      }
      if (url.includes('loadCodeAssist')) return jsonResponse({});
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    await currentCommand({
      json: true,
      quotaOptions: { fetchFn, env: { AGY_OAUTH_CLIENT_ID: 'env-client-id' } },
    });

    expect(writeSpy).not.toHaveBeenCalled();
    const stored = new RegistryManager().getAccounts()[0];
    expect(stored.credentials?.keychainPayload?.token.access_token).toBe('fresh-access-token');
    expect(stored.rateLimit?.gemini?.rate5h?.usedPercent).toBe(50);
  });
});

describe('Table parity and responsive layout', () => {
  const accounts: Account[] = [
    {
      id: 'a1',
      email: 'alice@example.com',
      alias: 'alice',
      authType: 'oauth',
      status: 'valid',
      plan: 'Google AI Ultra',
      rateLimit: {
        gemini: {
          rate5h: { usedPercent: 25, windowMinutes: 300, resetsAt: FUTURE_RESET },
          rateWeekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: FUTURE_RESET },
        },
        claude: { rate5h: { usedPercent: 75, windowMinutes: 300, resetsAt: FUTURE_RESET } },
      },
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: Date.now() - 60_000,
    },
    {
      id: 'a2',
      email: 'cjk@example.com',
      alias: '日本語テスト',
      authType: 'oauth',
      status: 'needs-reauth',
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  it('drops columns by retention priority as the terminal narrows', () => {
    const headerAt = (width: number) => getTableComponents(accounts, 'a1', width).headerLine;

    expect(headerAt(160)).toContain('LAST');
    expect(headerAt(160)).toContain('CLAUDE WK');

    // LAST is the first casualty, then the weekly columns, then CLAUDE 5H.
    const widths = [160, 70, 62, 52, 44, 36];
    const remaining = widths.map((w) => {
      const header = headerAt(w);
      return ['PLAN', 'GEMINI 5H', 'GEMINI WK', 'CLAUDE 5H', 'CLAUDE WK', 'LAST'].filter((column) =>
        header.includes(column)
      ).length;
    });

    for (let i = 1; i < remaining.length; i++) {
      expect(remaining[i]).toBeLessThanOrEqual(remaining[i - 1]);
    }
    expect(headerAt(36)).toContain('ACCOUNT');
  });

  it('falls back to account-only rendering on extremely narrow terminals', () => {
    const components = getTableComponents(accounts, 'a1', 18);
    expect(components.headerLine).toContain('ACCOUNT');
    expect(components.headerLine).not.toContain('PLAN');
    expect(components.rows[0].choiceText).toContain('01');
    for (const row of components.rows) {
      expect(row.coloredText.length).toBeGreaterThan(0);
    }
  });

  it('keeps list and the interactive picker on identical columns and widths', () => {
    for (const width of [160, 100, 70, 44]) {
      const table = renderAccountsTable(accounts, 'a1', width);
      const menu = renderSelectMenu(accounts, 'a1', 0, '', 'Select account to activate:', width);
      const header = getTableComponents(accounts, 'a1', width).headerLine;
      expect(table).toContain(header);
      expect(menu).toContain(header);
    }
  });

  it('renders concise error text instead of a quota reading for broken profiles', () => {
    const table = renderAccountsTable(accounts, 'a1', 160);
    expect(table).toContain('reauth');
    expect(table).toContain('75%');
  });
});

describe('Quota cache across import', () => {
  let testEnv: TestEnv;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    testEnv.cleanup();
  });

  function seedOne(account: Account): void {
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify(
        {
          schemaVersion: 3,
          activeAccountId: null,
          previousAccountId: null,
          accounts: [account],
          settings: { defaultLocation: 'global' },
        } satisfies Registry,
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  }

  function writeExport(account: Account): string {
    const file = path.join(testEnv.dir, 'export.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        kind: 'agy-auth-export',
        formatVersion: 2,
        registrySchemaVersion: 2,
        exportedAt: new Date().toISOString(),
        includesSecrets: false,
        accounts: [account],
      }),
      { mode: 0o600 }
    );
    return file;
  }

  it('keeps the fresher quota cache when overwriting an existing profile', async () => {
    const local = oauthAccount({
      plan: 'Local Plan',
      rateLimit: { gemini: { rate5h: { usedPercent: 10, windowMinutes: 300 } } },
      quotaCheckedAt: 2_000_000_000_000,
    });
    seedOne(local);

    const stale = {
      ...oauthAccount({
        plan: 'Imported Plan',
        rateLimit: { gemini: { rate5h: { usedPercent: 90, windowMinutes: 300 } } },
        quotaCheckedAt: 1_000_000_000_000,
      }),
      credentials: undefined,
    };
    await importCommand(writeExport(stale), { overwrite: true, json: true });

    let stored = new RegistryManager().getAccounts()[0];
    expect(stored.plan).toBe('Local Plan');
    expect(stored.rateLimit?.gemini?.rate5h?.usedPercent).toBe(10);
    expect(stored.quotaCheckedAt).toBe(2_000_000_000_000);

    const fresher = {
      ...oauthAccount({
        plan: 'Imported Plan',
        rateLimit: { gemini: { rate5h: { usedPercent: 90, windowMinutes: 300 } } },
        quotaCheckedAt: 3_000_000_000_000,
      }),
      credentials: undefined,
    };
    await importCommand(writeExport(fresher), { overwrite: true, json: true });

    stored = new RegistryManager().getAccounts()[0];
    expect(stored.plan).toBe('Imported Plan');
    expect(stored.rateLimit?.gemini?.rate5h?.usedPercent).toBe(90);
    expect(stored.quotaCheckedAt).toBe(3_000_000_000_000);
    // A status recorded elsewhere is never trusted across an import.
    expect(stored.status).toBe('unverified');
  });
});
