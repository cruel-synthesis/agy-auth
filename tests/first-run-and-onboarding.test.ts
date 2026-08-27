import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const promptMockState = {
  selectChoices: [] as Array<{ name: string; value: string }>,
  selectCallCount: 0,
  inputCallCount: 0,
  passwordCallCount: 0,
  passwordValue: 'AIzaSyMaskedPromptKey',
  shouldCancelSelect: false,
};

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(async (cfg: { choices: Array<{ name: string; value: string }> }) => {
    promptMockState.selectCallCount++;
    promptMockState.selectChoices = cfg.choices || [];
    if (promptMockState.shouldCancelSelect) {
      const err = new Error('ExitPromptError');
      err.name = 'ExitPromptError';
      throw err;
    }
    return cfg.choices[0]?.value || 'api-key';
  }),
  input: vi.fn(async () => {
    promptMockState.inputCallCount++;
    return 'default-input';
  }),
  password: vi.fn(async () => {
    promptMockState.passwordCallCount++;
    return promptMockState.passwordValue;
  }),
  confirm: vi.fn(async () => true),
  checkbox: vi.fn(async () => []),
}));

import { loginCommand } from '../src/commands/login.js';
import { runCli } from '../src/cli.js';
import * as antigravityStore from '../src/core/antigravity-store.js';
import { CliError } from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { OAUTH_SCOPES, OAuthFlow } from '../src/core/oauth.js';
import { RegistryManager } from '../src/core/registry.js';
import type { Account } from '../src/core/types.js';
import { printTopLevelHelp } from '../src/ui/help.js';
import { renderAccountsTable } from '../src/ui/table.js';
import { type TestEnv, setupTestEnvironment } from './test-utils.js';

describe('First-run and OAuth onboarding behavior', () => {
  let testEnv: TestEnv;
  const cliPath = path.resolve('bin/agy-auth.js');

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    promptMockState.selectChoices = [];
    promptMockState.selectCallCount = 0;
    promptMockState.inputCallCount = 0;
    promptMockState.passwordCallCount = 0;
    promptMockState.passwordValue = 'AIzaSyMaskedPromptKey';
    promptMockState.shouldCancelSelect = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    testEnv.cleanup();
  });

  function runSubprocess(args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync('node', [cliPath, ...args], {
        encoding: 'utf-8',
        env: {
          ...testEnv.createSubprocessEnv(),
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
      return {
        stdout: e.stdout?.toString() || '',
        stderr: e.stderr?.toString() || '',
        status: e.status ?? 1,
      };
    }
  }

  it('renders a concise first-run help under 25 lines with exactly one help pointer', () => {
    const res = runSubprocess([]);
    expect(res.status).toBe(0);

    const lines = res.stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThan(25);

    expect(res.stdout).toContain('list');
    expect(res.stdout).toContain('switch');
    expect(res.stdout).toContain('current');
    expect(res.stdout).toContain('login');
    expect(res.stdout).toContain('sync');
    expect(res.stdout).toContain('doctor');
    expect(res.stdout).toContain('agy-auth help --all');
  });

  it('adds an API key through a masked prompt when the option has no value', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    try {
      expect(
        await runCli([
          'node',
          'agy-auth',
          'add',
          '--api-key',
          '--email',
          'masked-key@example.com',
          '--alias',
          'masked-key',
        ])
      ).toBe(0);
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(promptMockState.passwordCallCount).toBe(1);
    expect(new RegistryManager().findAccount('masked-key')?.credentials?.apiKey).toBe(
      'AIzaSyMaskedPromptKey'
    );
  });

  it('rejects value-less API-key input outside a TTY without prompting', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      expect(
        await runCli([
          'node',
          'agy-auth',
          'add',
          '--api-key',
          '--email',
          'noninteractive@example.com',
        ])
      ).toBe(2);
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(promptMockState.passwordCallCount).toBe(0);
  });

  it('rejects value-less API-key input in JSON mode without prompting', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    try {
      expect(
        await runCli([
          'node',
          'agy-auth',
          'add',
          '--api-key',
          '--email',
          'json-mode@example.com',
          '--json',
        ])
      ).toBe(2);
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(promptMockState.passwordCallCount).toBe(0);
  });

  it('offers OAuth login choices and imports the selected Antigravity session', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(antigravityStore, 'readAntigravityToken').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'auto-import-token',
          refresh_token: '',
          expiry: '2030-01-01T00:00:00.000Z',
        },
      },
      keyringStatus: 'found',
      fileStatus: 'missing',
    });

    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({ email: 'auto-imported-user@example.com', email_verified: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await loginCommand({}, { fetchFn: fetchFn as unknown as typeof fetch });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(promptMockState.selectCallCount).toBe(1);
    expect(promptMockState.selectChoices.map((choice) => choice.value)).toEqual([
      'keychain',
      'antigravity',
    ]);
    expect(promptMockState.inputCallCount).toBe(0);

    const registry = new RegistryManager();
    const accounts = registry.getAccounts();
    expect(accounts.length).toBe(1);
    expect(accounts[0].email).toBe('auto-imported-user@example.com');
  });

  it('offers official Antigravity sign-in when no session or custom OAuth client is available', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(antigravityStore, 'readAntigravityToken').mockReturnValue({
      status: 'missing',
      keyringStatus: 'missing',
      fileStatus: 'missing',
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    promptMockState.shouldCancelSelect = true;

    try {
      await loginCommand({});
    } catch {
      // Expected abort
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(promptMockState.selectCallCount).toBe(1);
    const values = promptMockState.selectChoices.map((c) => c.value);
    expect(values).toEqual(['antigravity']);
  });

  it('offers custom browser OAuth only when a client ID is configured on macOS', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(antigravityStore, 'readAntigravityToken').mockReturnValue({
      status: 'missing',
      keyringStatus: 'missing',
      fileStatus: 'missing',
    });
    vi.stubEnv('AGY_OAUTH_CLIENT_ID', 'custom-client.apps.googleusercontent.com');

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    promptMockState.shouldCancelSelect = true;

    try {
      await loginCommand({});
    } catch {
      // Expected abort
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(promptMockState.selectChoices.map((choice) => choice.value)).toEqual([
      'antigravity',
      'browser',
    ]);
  });

  it('rejects Keychain import and offers browser OAuth on non-macOS', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(false);
    vi.spyOn(antigravityStore, 'readAntigravityToken').mockReturnValue({
      status: 'unsupported',
      keyringStatus: 'unsupported',
      fileStatus: 'missing',
    });

    await expect(loginCommand({ oauthSource: 'keychain' })).rejects.toThrow(CliError);
    await expect(loginCommand({ oauthSource: 'keychain' })).rejects.toThrow(
      /only supported on macOS/
    );

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    promptMockState.shouldCancelSelect = true;

    try {
      await loginCommand({});
    } catch {
      // Expected abort
    } finally {
      process.stdin.isTTY = origTTY;
    }

    const values = promptMockState.selectChoices.map((c) => c.value);
    expect(values).toEqual(['browser']);
  });

  it('requests only public OAuth scopes in browser flow', async () => {
    expect(OAUTH_SCOPES).toBe(
      'openid email profile https://www.googleapis.com/auth/cloud-platform'
    );

    let generatedUrl = '';
    const openBrowserFn = (url: string) => {
      generatedUrl = url;
    };

    const authPromise = OAuthFlow.authenticate({
      env: { AGY_OAUTH_CLIENT_ID: 'test-client-id-123' },
      openBrowserFn,
      timeoutMs: 100,
    });

    try {
      await authPromise;
    } catch {
      // Expected timeout
    }

    expect(generatedUrl).toContain('client_id=test-client-id-123');
    expect(generatedUrl).toContain('cloud-platform');
    expect(generatedUrl).not.toContain('cclog');
    expect(generatedUrl).not.toContain('experimentsandconfigs');
    expect(generatedUrl).not.toContain('aicode');
  });

  it('lists all commands on help --all and primary set on bare help', () => {
    const logsAll: string[] = [];
    const spyAll = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logsAll.push(args.join(' '));
    });
    try {
      printTopLevelHelp(true);
      const textAll = logsAll.join('\n');
      expect(textAll).toContain('Configuration and maintenance:');
      expect(textAll).toContain('alias');
      expect(textAll).toContain('project');
      expect(textAll).toContain('model');
      expect(textAll).toContain('export');
      expect(textAll).toContain('import');
      expect(textAll).toContain('clean');
      expect(textAll).toContain('env');
      expect(textAll).toContain('Add an API key, service-account, or ADC profile');
      expect(textAll).not.toContain('Add a credential profile non-interactively');
    } finally {
      spyAll.mockRestore();
    }

    const logsBare: string[] = [];
    const spyBare = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logsBare.push(args.join(' '));
    });
    try {
      printTopLevelHelp(false);
      const textBare = logsBare.join('\n');
      expect(textBare).not.toContain('Configuration and maintenance:');
      expect(textBare).toContain('list');
      expect(textBare).toContain('switch');
      expect(textBare).toContain('current');
      expect(textBare).toContain('login');
      expect(textBare).toContain('sync');
      expect(textBare).toContain('doctor');
      expect(textBare).toContain('agy-auth help --all');
    } finally {
      spyBare.mockRestore();
    }

    const allRes = runSubprocess(['help', '--all']);
    expect(allRes.status).toBe(0);
    expect(allRes.stdout).toContain('alias');
    expect(allRes.stdout).toContain('project');
    expect(allRes.stdout).toContain('model');
    expect(allRes.stdout).toContain('export');
    expect(allRes.stdout).toContain('import');
    expect(allRes.stdout).toContain('clean');
    expect(allRes.stdout).toContain('env');

    const bareRes = runSubprocess(['--help']);
    expect(bareRes.status).toBe(0);
    expect(bareRes.stdout).not.toContain('Configuration and maintenance:');
    expect(bareRes.stdout).toContain('agy-auth help --all');
  });

  it('displays distinct hint lines for expired sessions versus uncached quota', () => {
    const expiredAccount: Account = {
      id: 'acc_exp',
      email: 'expired@example.com',
      authType: 'oauth',
      status: 'expired',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const tableExpired = renderAccountsTable([expiredAccount], null, 120);
    expect(tableExpired).toContain(
      "Hint: Run 'agy-auth sync' to import your active Antigravity session."
    );

    const uncachedAccount: Account = {
      id: 'acc_uncached',
      email: 'uncached@example.com',
      authType: 'oauth',
      status: 'valid',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const tableUncached = renderAccountsTable([uncachedAccount], null, 120);
    expect(tableUncached).toContain(
      "Hint: Run 'agy-auth list --check' to fetch live quota over the network."
    );

    const emptyTable = renderAccountsTable([], null, 120);
    expect(emptyTable).toContain("No accounts registered. Run 'agy-auth login' to add one.");
    expect(emptyTable).not.toContain("Run 'agy-auth sync' or 'agy-auth login'");
  });

  it('renders mixed-width rows without clipping shorter cells when terminal width is sufficient', () => {
    const shortAcc: Account = {
      id: 'acc_short',
      email: 'short@example.com',
      authType: 'api-key',
      status: 'valid',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const longAcc: Account = {
      id: 'acc_long',
      email: 'long-address@example.invalid',
      authType: 'api-key',
      status: 'valid',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const table = renderAccountsTable([shortAcc, longAcc], null, 140);
    expect(table).toContain('short@example.com');
    expect(table).toContain('long-address@example.invalid');
  });
});
