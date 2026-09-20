import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardedNodeArgs } from './test-utils.js';

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

import { runCli } from '../src/cli.js';
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
      const stdout = execFileSync('node', guardedNodeArgs(cliPath, ...args), {
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
    expect(res.stdout).toContain('add');
    expect(res.stdout).toContain('remove');
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

  it('requests the same scopes as Antigravity in browser flow', async () => {
    // Asking for less produces a token the quota contracts refuse, and a profile
    // unlike the one `add` imports. These are Antigravity's own scopes.
    expect(OAUTH_SCOPES).toBe(
      [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
      ].join(' ')
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

    const params = new URL(generatedUrl).searchParams;
    expect(params.get('client_id')).toBe('test-client-id-123');
    // The URL carries the declared set and nothing beyond it.
    expect(params.get('scope')).toBe(OAUTH_SCOPES);
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
      expect(textAll).toContain('Add an API key, service account, or ADC credential');
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
      expect(textBare).toContain('add');
      expect(textBare).toContain('remove');
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
      "Hint: Run 'agy-auth add' to import your active Antigravity session."
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
    expect(emptyTable).toContain('No accounts yet. Run `agy-auth add`');
    expect(emptyTable).not.toContain("Run 'agy-auth add' or 'agy-auth login'");
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
