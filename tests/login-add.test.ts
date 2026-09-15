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

import { addCommand, validateEmailInput } from '../src/commands/add.js';
import { exportCommand } from '../src/commands/export.js';
import { loginCommand, validateAliasInput } from '../src/commands/login.js';
import { removeCommand } from '../src/commands/remove.js';
import { CancellationError, CliError, UsageError } from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { RegistryManager } from '../src/core/registry.js';
import { TestEnv, futureExpiry, pastExpiry, setupTestEnvironment } from './test-utils.js';

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

    expect(validateEmailInput('valid@example.com')).toBe(true);
    expect(typeof validateEmailInput('invalid')).toBe('string');
  });

  it('adds a browser OAuth profile', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    try {
      await loginCommand(
        {
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
                expiry: futureExpiry(),
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
      // A user returning to the default browser sign-in, which uses the same
      // Antigravity client that issued the stored refresh token.
      credentialSource: 'antigravity',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'old-access-token',
            refresh_token: 'durable-refresh-token',
            token_type: 'Bearer',
            expiry: pastExpiry(),
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
        {},
        {
          authenticateOAuth: async () => ({
            email: 'RETURNING@example.com',
            payload: {
              auth_method: 'consumer',
              token: {
                access_token: 'new-access-token',
                refresh_token: '',
                token_type: 'Bearer',
                expiry: futureExpiry(),
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

  it('keeps a refresh token when the same custom client signs in, drops it otherwise', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'byo@example.com',
      authType: 'oauth',
      credentialSource: 'custom-client',
      oauthClientId: 'byo-client-id',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'old-access-token',
            refresh_token: 'byo-refresh-token',
            token_type: 'Bearer',
            expiry: pastExpiry(),
          },
        },
      },
      status: 'expired',
    });

    const signIn = async () => ({
      email: 'byo@example.com',
      payload: {
        auth_method: 'consumer' as const,
        token: {
          access_token: 'new-access-token',
          refresh_token: '',
          token_type: 'Bearer',
          expiry: futureExpiry(),
        },
      },
    });

    const origTTY = process.stdin.isTTY;
    const origClient = process.env.AGY_OAUTH_CLIENT_ID;
    process.stdin.isTTY = true;
    try {
      // Signing in again with the same client that issued the token: reusable.
      process.env.AGY_OAUTH_CLIENT_ID = 'byo-client-id';
      await loginCommand({}, { authenticateOAuth: signIn });
      expect(
        new RegistryManager().getAccounts()[0].credentials?.keychainPayload?.token
      ).toMatchObject({ access_token: 'new-access-token', refresh_token: 'byo-refresh-token' });

      // A different client. Google would refuse the old token, so it is not kept.
      process.env.AGY_OAUTH_CLIENT_ID = 'other-client-id';
      await loginCommand({}, { authenticateOAuth: signIn });
      expect(
        new RegistryManager().getAccounts()[0].credentials?.keychainPayload?.token
      ).toMatchObject({ access_token: 'new-access-token', refresh_token: '' });
    } finally {
      process.stdin.isTTY = origTTY;
      if (origClient === undefined) {
        delete process.env.AGY_OAUTH_CLIENT_ID;
      } else {
        process.env.AGY_OAUTH_CLIENT_ID = origClient;
      }
    }
  });

  it('rejects an invalid alias with UsageError', async () => {
    await expect(loginCommand({ alias: 'invalid alias with spaces' })).rejects.toThrow(UsageError);
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
      await expect(addCommand({})).rejects.toThrow(CancellationError);
    } finally {
      process.stdin.isTTY = origTTY;
      supportedSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('refuses an unverifiable session without touching the saved profile', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'existing@example.com',
      authType: 'oauth',
      status: 'valid',
      verification: { checkedAt: 1700000000000, source: 'userinfo' },
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'saved-access',
            refresh_token: 'saved-refresh',
            token_type: 'Bearer',
          },
        },
      },
    });

    const supportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'unattributable-access',
          refresh_token: '',
          token_type: 'Bearer',
          expiry: futureExpiry(),
        },
      },
    });

    const offlineFetch = vi.fn(async () => {
      throw new Error('Network unavailable');
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // A session that cannot be attributed is refused outright: reporting a
      // successful run that saved nothing would be worse than an error.
      await expect(
        addCommand(
          { email: 'existing@example.com', json: true, yes: true },
          { fetchFn: offlineFetch as unknown as typeof fetch }
        )
      ).rejects.toThrow(/could not confirm/i);

      // Nothing was written over the saved profile.
      const stored = new RegistryManager().getAccounts()[0];
      expect(stored.credentials?.keychainPayload?.token.access_token).toBe('saved-access');
      expect(stored.status).toBe('valid');
    } finally {
      logSpy.mockRestore();
      supportedSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('throws CliError when the session store cannot be read', async () => {
    const supportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'error',
      message: 'Keychain locked',
    });

    try {
      await expect(addCommand({})).rejects.toMatchObject({ code: 'session_store_error' });
    } finally {
      supportedSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
