import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCli, runCli } from '../src/cli.js';
import { CancellationError, CliError } from '../src/core/errors.js';
import { RegistryManager } from '../src/core/registry.js';
import { generateSyntheticPrivateKey, setupTestEnvironment, TestEnv } from './test-utils.js';

describe('CLI unit tests and option dispatch', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('instantiates the CLI and handles top-level help option', () => {
    const cli = createCli();
    expect(cli.name()).toBe('agy-auth');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      (cli as unknown as { helpInformation: () => void }).helpInformation();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns exit code 0 for help subcommand', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runCli(['node', 'agy-auth', 'help'])).toBe(0);
      expect(await runCli(['node', 'agy-auth', 'help', 'list'])).toBe(0);
      expect(await runCli(['node', 'agy-auth', 'help', 'nonexistent'])).toBe(2);
    } finally {
      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('runs add, list, current, details, doctor, clean, env commands via runCli returning exit code 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Add
      expect(
        await runCli([
          'node',
          'agy-auth',
          'add',
          '--api-key',
          'AIzaSyTest12345',
          '--email',
          'cli-test@example.com',
          '--alias',
          'cli-alias',
          '--json',
        ])
      ).toBe(0);

      // List
      expect(await runCli(['node', 'agy-auth', 'list', '--json'])).toBe(0);

      // Switch
      expect(await runCli(['node', 'agy-auth', 'switch', 'cli-alias', '--json'])).toBe(0);

      // Current
      expect(await runCli(['node', 'agy-auth', 'current', '--json'])).toBe(0);

      // Details
      expect(await runCli(['node', 'agy-auth', 'details', 'cli-alias', '--json'])).toBe(0);

      // Env
      expect(await runCli(['node', 'agy-auth', 'env', '--json'])).toBe(0);

      // Clean
      expect(await runCli(['node', 'agy-auth', 'clean', '--dry-run', '--json'])).toBe(0);

      // Doctor
      expect(await runCli(['node', 'agy-auth', 'doctor', '--offline', '--json'])).toBe(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('runs alias, project, model commands via runCli returning exit code 0', async () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'unit@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyUnitKey' },
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await runCli(['node', 'agy-auth', 'alias', 'set', acc.id, 'unit-alias', '--json'])
      ).toBe(0);
      expect(new RegistryManager().findAccount(acc.id)?.alias).toBe('unit-alias');

      expect(
        await runCli([
          'node',
          'agy-auth',
          'project',
          'set',
          acc.id,
          'unit-proj',
          'global',
          '--json',
        ])
      ).toBe(0);
      expect(new RegistryManager().findAccount(acc.id)?.gcpProject).toBe('unit-proj');

      expect(
        await runCli(['node', 'agy-auth', 'model', 'set', acc.id, 'gemini-2.5-pro', '--json'])
      ).toBe(0);
      expect(new RegistryManager().findAccount(acc.id)?.model).toBe('gemini-2.5-pro');

      expect(await runCli(['node', 'agy-auth', 'model', 'clear', acc.id, '--json'])).toBe(0);
      expect(new RegistryManager().findAccount(acc.id)?.model).toBeUndefined();

      expect(await runCli(['node', 'agy-auth', 'project', 'clear', acc.id, '--json'])).toBe(0);
      expect(new RegistryManager().findAccount(acc.id)?.gcpProject).toBeUndefined();

      expect(await runCli(['node', 'agy-auth', 'alias', 'clear', acc.id, '--json'])).toBe(0);
      expect(new RegistryManager().findAccount(acc.id)?.alias).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('supports JSON output on the previous-profile shortcut', async () => {
    const registry = new RegistryManager();
    const first = registry.addOrUpdateAccount({
      email: 'first@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'synthetic-first-key' },
    });
    const second = registry.addOrUpdateAccount({
      email: 'second@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'synthetic-second-key' },
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runCli(['node', 'agy-auth', 'switch', first.id, '--json'])).toBe(0);
      expect(await runCli(['node', 'agy-auth', 'switch', second.id, '--json'])).toBe(0);
      expect(await runCli(['node', 'agy-auth', '-', '--json'])).toBe(0);
      expect(new RegistryManager().getActiveAccount()?.id).toBe(first.id);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns exit code 2 on unknown flags or usage errors', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await runCli(['node', 'agy-auth', 'list', '--unknown-flag']);
      expect(code).toBe(2);
    } finally {
      consoleSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('outputs JSON error envelope on failure in JSON mode', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'user@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyUserKey' },
    });

    let captured = '';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      captured += msg;
    });
    try {
      const code = await runCli(['node', 'agy-auth', 'switch', 'non-existent-account', '--json']);
      expect(code).toBe(1);
      const parsed = JSON.parse(captured);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.command).toBe('switch');
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('account_not_found');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('outputs text error to stderr on failure in non-JSON mode', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'existing@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await runCli(['node', 'agy-auth', 'switch', 'non-existent-account']);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('handles unexpected non-CliError exceptions in JSON and text modes', async () => {
    const cli = createCli();
    const origParse = cli.parseAsync.bind(cli);
    vi.spyOn(cli, 'parseAsync').mockRejectedValue(new Error('Unexpected disk read error'));

    let jsonCaptured = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => {
      jsonCaptured += m;
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const codeJson = await runCli(['node', 'agy-auth', 'list', '--json'], cli);
      expect(codeJson).toBe(1);
      const parsed = JSON.parse(jsonCaptured);
      expect(parsed.error.code).toBe('internal_error');
      expect(parsed.error.message).toContain('Unexpected disk read error');

      const codeText = await runCli(['node', 'agy-auth', 'list'], cli);
      expect(codeText).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('suppresses error logging on CancellationError (code 130)', async () => {
    const cli = createCli();
    vi.spyOn(cli, 'parseAsync').mockRejectedValue(new CancellationError());
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const code = await runCli(['node', 'agy-auth', 'sync'], cli);
      expect(code).toBe(130);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('returns exit code 2 for the removed login method option', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await runCli(['node', 'agy-auth', 'login', '--method', 'invalid-mode']);
      expect(code).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
