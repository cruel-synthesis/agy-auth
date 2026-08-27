import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = {
  selectValue: 'api-key',
  passwordValue: 'AIzaSyMockKey',
  inputResponses: [] as string[],
  confirmValue: true,
  checkboxValue: [] as string[],
  shouldThrowExitPrompt: false,
};

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(async () => {
    if (mockState.shouldThrowExitPrompt) {
      const err = new Error('Prompt exit');
      err.name = 'ExitPromptError';
      throw err;
    }
    return mockState.selectValue;
  }),
  password: vi.fn(async () => {
    if (mockState.shouldThrowExitPrompt) {
      const err = new Error('Prompt exit');
      err.name = 'ExitPromptError';
      throw err;
    }
    return mockState.passwordValue;
  }),
  input: vi.fn(async () => {
    if (mockState.shouldThrowExitPrompt) {
      const err = new Error('Prompt exit');
      err.name = 'ExitPromptError';
      throw err;
    }
    const next = mockState.inputResponses.shift();
    return next !== undefined ? next : 'default-input';
  }),
  confirm: vi.fn(async () => {
    if (mockState.shouldThrowExitPrompt) {
      const err = new Error('Prompt exit');
      err.name = 'ExitPromptError';
      throw err;
    }
    return mockState.confirmValue;
  }),
  checkbox: vi.fn(async () => {
    if (mockState.shouldThrowExitPrompt) {
      const err = new Error('Prompt exit');
      err.name = 'ExitPromptError';
      throw err;
    }
    return mockState.checkboxValue;
  }),
}));

import { exportCommand } from '../src/commands/export.js';
import { loginCommand, validateAliasInput } from '../src/commands/login.js';
import { removeCommand } from '../src/commands/remove.js';
import { syncCommand, validateSyncEmail } from '../src/commands/sync.js';
import { CancellationError, CliError, UsageError } from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { RegistryManager } from '../src/core/registry.js';
import { setupTestEnvironment, TestEnv } from './test-utils.js';

describe('Interactive Login, Sync, and Remove Commands with Prompt Mocking', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    mockState.selectValue = 'api-key';
    mockState.passwordValue = 'AIzaSyMockKey';
    mockState.inputResponses = [];
    mockState.confirmValue = true;
    mockState.checkboxValue = [];
    mockState.shouldThrowExitPrompt = false;
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('validates login aliases and sync emails', () => {
    expect(validateAliasInput('valid-alias')).toBe(true);
    expect(validateAliasInput('')).toBe(true);
    expect(typeof validateAliasInput('invalid spaces')).toBe('string');

    expect(validateSyncEmail('valid@example.com')).toBe(true);
    expect(typeof validateSyncEmail('invalid')).toBe('string');
  });

  it('fails loginCommand in non-TTY mode with UsageError', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await expect(loginCommand()).rejects.toThrow(
        'Pass `--oauth-source keychain` or `--oauth-source browser` explicitly.'
      );
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('adds an OAuth profile using default macOS Keychain import without client ID', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'default-kc-token',
          refresh_token: 'default-kc-refresh',
          token_type: 'Bearer',
          expiry: '2030-01-01T00:00:00.000Z',
        },
      },
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    try {
      await loginCommand(
        {
          oauthSource: 'keychain',
          alias: 'kc-profile',
          project: 'kc-project',
          location: 'us-central1',
          model: 'gemini-2.5-pro',
        },
        {
          fetchFn: vi.fn(async () => {
            return new Response(
              JSON.stringify({ email: 'keychain-user@example.com', email_verified: true }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }) as unknown as typeof fetch,
        }
      );

      const account = new RegistryManager().findAccount('kc-profile');
      expect(account).toMatchObject({
        email: 'keychain-user@example.com',
        alias: 'kc-profile',
        authType: 'oauth',
        status: 'valid',
        gcpProject: 'kc-project',
        gcpLocation: 'us-central1',
        model: 'gemini-2.5-pro',
      });
      expect(account?.credentials?.keychainPayload?.token).toMatchObject({
        access_token: 'default-kc-token',
        refresh_token: 'default-kc-refresh',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('adds a browser OAuth profile when explicitly requested via --oauth-source browser', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    try {
      await loginCommand(
        {
          oauthSource: 'browser',
          alias: 'browser-oauth',
          project: 'oauth-project',
          location: 'us-central1',
          model: 'gemini-test',
        },
        {
          authenticateOAuth: async () => ({
            email: 'oauth-user@example.com',
            payload: {
              auth_method: 'consumer',
              token: {
                access_token: 'synthetic-access-token',
                refresh_token: 'synthetic-refresh-token',
                token_type: 'Bearer',
                expiry: '2030-01-01T00:00:00.000Z',
              },
            },
          }),
        }
      );

      const account = new RegistryManager().findAccount('browser-oauth');
      expect(account).toMatchObject({
        email: 'oauth-user@example.com',
        alias: 'browser-oauth',
        authType: 'oauth',
        status: 'valid',
        gcpProject: 'oauth-project',
        gcpLocation: 'us-central1',
        model: 'gemini-test',
      });
      expect(account?.credentials?.keychainPayload?.token).toMatchObject({
        access_token: 'synthetic-access-token',
        refresh_token: 'synthetic-refresh-token',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('refreshes an existing OAuth profile in place and retains its refresh token', async () => {
    const registry = new RegistryManager();
    const existing = registry.addOrUpdateAccount({
      email: 'returning@example.com',
      alias: 'returning-user',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'old-access-token',
            refresh_token: 'durable-refresh-token',
            token_type: 'Bearer',
            expiry: '2025-01-01T00:00:00.000Z',
          },
        },
      },
      gcpProject: 'existing-project',
      gcpLocation: 'global',
      model: 'existing-model',
      status: 'expired',
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await loginCommand(
        { oauthSource: 'browser' },
        {
          authenticateOAuth: async () => ({
            email: 'RETURNING@example.com',
            payload: {
              auth_method: 'consumer',
              token: {
                access_token: 'new-access-token',
                refresh_token: '',
                token_type: 'Bearer',
                expiry: '2030-01-01T00:00:00.000Z',
              },
            },
          }),
        }
      );

      const accounts = new RegistryManager().getAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: existing.id,
        alias: 'returning-user',
        gcpProject: 'existing-project',
        gcpLocation: 'global',
        model: 'existing-model',
        status: 'valid',
      });
      expect(accounts[0].credentials?.keychainPayload?.token).toMatchObject({
        access_token: 'new-access-token',
        refresh_token: 'durable-refresh-token',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('rejects an invalid OAuth source or alias with UsageError', async () => {
    await expect(loginCommand({ oauthSource: 'invalid-source' })).rejects.toThrow(UsageError);
    await expect(loginCommand({ alias: 'invalid alias with spaces' })).rejects.toThrow(UsageError);
  });

  it('interactively adds an Antigravity Keychain OAuth account when selected from menu', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'inter-kc-token',
          refresh_token: '',
          token_type: 'Bearer',
        },
      },
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockState.selectValue = 'keychain';

    try {
      await loginCommand(
        {},
        {
          fetchFn: vi.fn(async () => {
            return new Response(
              JSON.stringify({ email: 'interactive-kc@example.com', email_verified: true }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }) as unknown as typeof fetch,
        }
      );

      const account = new RegistryManager()
        .getAccounts()
        .find((a) => a.email === 'interactive-kc@example.com');
      expect(account).toBeTruthy();
      expect(account?.authType).toBe('oauth');
      expect(account?.status).toBe('valid');
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('adds a custom browser OAuth account via --oauth-source browser', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    try {
      await loginCommand(
        { oauthSource: 'browser' },
        {
          authenticateOAuth: async () => ({
            email: 'interactive-browser@example.com',
            payload: {
              auth_method: 'consumer',
              token: {
                access_token: 'inter-access-token',
                refresh_token: 'inter-refresh-token',
                token_type: 'Bearer',
                expiry: '2030-01-01T00:00:00.000Z',
              },
            },
          }),
        }
      );

      const account = new RegistryManager()
        .getAccounts()
        .find((a) => a.email === 'interactive-browser@example.com');
      expect(account).toBeTruthy();
      expect(account?.authType).toBe('oauth');
      expect(account?.status).toBe('valid');
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('opens Antigravity sign-in and imports the resulting account', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'official-antigravity-token',
          refresh_token: '',
          token_type: 'Bearer',
        },
      },
    });
    const openAntigravity = vi.fn(() => true);
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockState.selectValue = 'antigravity';

    try {
      await loginCommand(
        {},
        {
          openAntigravity,
          fetchFn: vi.fn(async () => {
            return new Response(
              JSON.stringify({ email: 'official-login@example.com', email_verified: true }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }) as unknown as typeof fetch,
        }
      );

      expect(openAntigravity).toHaveBeenCalledOnce();
      expect(new RegistryManager().findAccount('official-login@example.com')).toBeTruthy();
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('cancels removal when interactive confirmation is declined in removeCommand', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'rem-cancel@example.com',
      alias: 'rem-cancel',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSy1' },
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockState.confirmValue = false; // User selects No

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await removeCommand(['rem-cancel'], { yes: false });
      expect(new RegistryManager().findAccount('rem-cancel')).toBeTruthy();
    } finally {
      process.stdin.isTTY = origTTY;
      logSpy.mockRestore();
    }
  });

  it('rejects combining profile selectors with remove --all without deleting anything', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'remove-one@example.com',
      alias: 'remove-one',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSy1' },
    });
    registry.addOrUpdateAccount({
      email: 'keep-one@example.com',
      alias: 'keep-one',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSy2' },
    });

    await expect(removeCommand(['remove-one'], { all: true, yes: true })).rejects.toBeInstanceOf(
      UsageError
    );
    expect(new RegistryManager().getAccounts()).toHaveLength(2);
  });

  it('confirms removal with interactive prompt and with --all flag', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'all1@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSy1' },
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    // 1. User cancels remove --all
    mockState.confirmValue = false;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await removeCommand([], { all: true, yes: false });
      expect(new RegistryManager().getAccounts().length).toBe(1);

      // 2. User confirms remove --all
      mockState.confirmValue = true;
      await removeCommand([], { all: true, yes: false });
      expect(new RegistryManager().getAccounts().length).toBe(0);
    } finally {
      process.stdin.isTTY = origTTY;
      logSpy.mockRestore();
    }
  });

  it('prompts for confirmation when exporting secrets interactively in exportCommand', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'exp-inter@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });

    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    const exportPath = path.join(testEnv.dir, 'inter-export.json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // 1. User cancels
      mockState.confirmValue = false;
      await exportCommand({ output: exportPath, includeSecrets: true, yes: false });
      expect(fs.existsSync(exportPath)).toBe(false);

      // 2. User confirms
      mockState.confirmValue = true;
      await exportCommand({ output: exportPath, includeSecrets: true, yes: false });
      expect(fs.existsSync(exportPath)).toBe(true);
    } finally {
      process.stdin.isTTY = origTTY;
      logSpy.mockRestore();
    }
  });

  it('propagates cancellation on ExitPromptError during interactive sync', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockState.shouldThrowExitPrompt = true;

    const supportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'ya29.tok', refresh_token: '1//ref' },
      },
    });

    try {
      await expect(syncCommand({})).rejects.toThrow(CancellationError);
    } finally {
      process.stdin.isTTY = origTTY;
      supportedSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('throws CliError on session-store error during sync', async () => {
    const supportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'error',
      message: 'Keychain locked',
    });

    try {
      await expect(syncCommand({})).rejects.toMatchObject({ code: 'session_store_error' });
    } finally {
      supportedSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
