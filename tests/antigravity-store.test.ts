import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/commands/doctor.js';
import { readAntigravityToken, writeAntigravityToken } from '../src/core/antigravity-store.js';
import { importKeychainOAuth } from '../src/core/keychain-import.js';
import { KeychainManager, parseAgyKeychainPayload } from '../src/core/keychain.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { Switcher } from '../src/core/switcher.js';
import type { KeychainPayload } from '../src/core/types.js';
import { futureExpiry, HOUR_MS, setupTestEnvironment, type TestEnv } from './test-utils.js';

describe('Composite Antigravity Token Store Subsystem', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('reads and rewrites a session carrying fields agy-auth does not model', () => {
    // The installed Antigravity CLI stores an id_token alongside the token
    // object. Rejecting it makes every real session unreadable, and dropping it
    // on write corrupts the session the official client relies on.
    const realWorldPayload = {
      auth_method: 'consumer',
      id_token: 'header.payload.signature',
      token: {
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        expiry: futureExpiry(),
        scope: 'openid email',
      },
    };

    const parsed = parseAgyKeychainPayload(realWorldPayload);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      auth_method: 'consumer',
      id_token: 'header.payload.signature',
      token: { scope: 'openid email' },
    });

    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(realWorldPayload));
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(false);

    const readBack = readAntigravityToken();
    expect(readBack.status).toBe('found');
    expect(readBack.payload).toMatchObject({
      id_token: 'header.payload.signature',
      token: { scope: 'openid email' },
    });

    // Writing the session back must hand the official client every field it
    // gave us, not just the ones agy-auth understands.
    const written = writeAntigravityToken(readBack.payload as KeychainPayload);
    expect(written.ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(Paths.antigravityTokenFile, 'utf-8'));
    expect(onDisk).toMatchObject({
      id_token: 'header.payload.signature',
      token: { scope: 'openid email', token_type: 'Bearer' },
    });
  });

  it('prefers keyring payload when keyring expiry is fresher than file expiry', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'keyring-fresh-token',
          refresh_token: 'keyring-refresh',
          expiry: '2026-08-24T18:00:00.000Z',
        },
      },
    });

    const filePayload: KeychainPayload = {
      auth_method: 'consumer',
      token: {
        access_token: 'file-stale-token',
        refresh_token: 'file-refresh',
        expiry: '2026-08-24T12:00:00.000Z',
      },
    };
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(filePayload));

    const result = readAntigravityToken();
    expect(result.status).toBe('found');
    expect(result.source).toBe('keyring');
    expect(result.payload?.token.access_token).toBe('keyring-fresh-token');
  });

  it('prefers file payload when file expiry is fresher than keyring expiry, and import uses it', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'stale-keyring-token',
          refresh_token: 'stale-refresh',
          expiry: '2026-08-23T11:34:22.000Z', // Old/stale
        },
      },
    });

    const freshFilePayload: KeychainPayload = {
      auth_method: 'consumer',
      token: {
        access_token: 'live-file-token',
        refresh_token: 'live-file-refresh',
        expiry: '2026-08-24T18:39:34.000Z', // Fresh
      },
    };
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(freshFilePayload));

    const result = readAntigravityToken();
    expect(result.status).toBe('found');
    expect(result.source).toBe('file');
    expect(result.payload?.token.access_token).toBe('live-file-token');

    // Verify import uses the fresh token and creates a valid profile
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({ email: 'fresh-file-user@example.com', email_verified: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const importResult = await importKeychainOAuth({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(importResult.status).toBe('success');
    if (importResult.status === 'success') {
      expect(importResult.account.email).toBe('fresh-file-user@example.com');
      expect(importResult.account.status).toBe('valid');
      expect(importResult.account.credentials?.keychainPayload?.token.access_token).toBe(
        'live-file-token'
      );
    }
  });

  it('uses file payload when keyring item is missing entirely', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'missing',
    });

    const filePayload: KeychainPayload = {
      auth_method: 'consumer',
      token: {
        access_token: 'fallback-file-token',
        refresh_token: 'file-refresh',
        expiry: '2026-08-24T15:00:00.000Z',
      },
    };
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(filePayload));

    const result = readAntigravityToken();
    expect(result.status).toBe('found');
    expect(result.source).toBe('file');
    expect(result.payload?.token.access_token).toBe('fallback-file-token');
  });

  it('rejects a symbolic link in place of the Antigravity token file', () => {
    if (process.platform === 'win32') return;

    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({ status: 'missing' });
    const externalToken = path.join(testEnv.dir, 'external-token.json');
    fs.writeFileSync(
      externalToken,
      JSON.stringify({
        auth_method: 'consumer',
        token: { access_token: 'external-token', refresh_token: 'external-refresh' },
      })
    );
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.symlinkSync(externalToken, Paths.antigravityTokenFile);

    const result = readAntigravityToken();
    expect(result.status).toBe('error');
    expect(result.fileStatus).toBe('error');
    expect(result.fileMessage).toContain('must be a regular file');
    expect(result.payload).toBeUndefined();
  });

  it('rejects a token file replaced by a symbolic link between validation and read', () => {
    if (process.platform === 'win32') return;

    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({ status: 'missing' });
    const tokenFile = Paths.antigravityTokenFile;
    const externalToken = path.join(testEnv.dir, 'race-target.json');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        auth_method: 'consumer',
        token: { access_token: 'original-token', refresh_token: '' },
      })
    );
    fs.writeFileSync(
      externalToken,
      JSON.stringify({
        auth_method: 'consumer',
        token: { access_token: 'linked-token', refresh_token: '' },
      })
    );

    const originalLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, options) => {
      const stat = originalLstat(filePath, options as never);
      if (path.resolve(String(filePath)) === path.resolve(tokenFile)) {
        fs.unlinkSync(tokenFile);
        fs.symlinkSync(externalToken, tokenFile);
      }
      return stat as never;
    });

    const result = readAntigravityToken();
    expect(result.status).toBe('error');
    expect(result.fileStatus).toBe('error');
    expect(result.payload).toBeUndefined();
  });

  it('rejects an Antigravity token file larger than the credential size limit', () => {
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({ status: 'missing' });
    const payload = JSON.stringify({
      auth_method: 'consumer',
      token: { access_token: 'oversized-token', refresh_token: '' },
    });
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, `${payload}${' '.repeat(1024 * 1024)}`);

    const result = readAntigravityToken();
    expect(result.status).toBe('error');
    expect(result.fileStatus).toBe('error');
    expect(result.fileMessage).toContain('maximum size');
    expect(result.payload).toBeUndefined();
  });

  it('rejects token-file payloads with missing or whitespace-only authentication methods', () => {
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({ status: 'missing' });
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });

    for (const authMethod of [undefined, '   ', '\t\n ']) {
      const payload = {
        ...(authMethod === undefined ? {} : { auth_method: authMethod }),
        token: { access_token: 'synthetic-file-token', refresh_token: '' },
      };
      fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(payload));

      const result = readAntigravityToken();
      expect(result.status).toBe('error');
      expect(result.fileStatus).toBe('error');
    }
  });

  it('uses available half and surfaces warning when the other half is unparseable', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'error',
      message: 'The Antigravity Keychain item is not valid JSON.',
    });

    const filePayload: KeychainPayload = {
      auth_method: 'consumer',
      token: {
        access_token: 'healthy-file-token',
        refresh_token: 'file-refresh',
      },
    };
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(filePayload));

    const result = readAntigravityToken();
    expect(result.status).toBe('found');
    expect(result.source).toBe('file');
    expect(result.payload?.token.access_token).toBe('healthy-file-token');
    expect(result.warning).toContain('not valid JSON');
  });

  it('writes both file and keyring halves during switch', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    let mockKeychainStore: string | null = null;
    vi.spyOn(KeychainManager, 'writeAgyToken').mockImplementation((p) => {
      mockKeychainStore = JSON.stringify(p);
      return true;
    });
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockImplementation(() => {
      if (!mockKeychainStore) return { status: 'missing' };
      return { status: 'found', payload: JSON.parse(mockKeychainStore) };
    });

    const registry = new RegistryManager();
    const account = registry.addOrUpdateAccount({
      email: 'dual-store@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'dual-access-token',
            refresh_token: 'dual-refresh-token',
          },
        },
      },
    });

    const switchResult = Switcher.switchAccount(account);
    expect(switchResult.antigravityUpdated).toBe(true);
    expect(switchResult.warnings).toBeUndefined();

    // Verify file on disk
    expect(fs.existsSync(Paths.antigravityTokenFile)).toBe(true);
    const diskContent = JSON.parse(fs.readFileSync(Paths.antigravityTokenFile, 'utf-8'));
    expect(diskContent.token.access_token).toBe('dual-access-token');

    // Verify keyring mock
    expect(mockKeychainStore).not.toBeNull();
    const keyringContent = JSON.parse(mockKeychainStore || '{}');
    expect(keyringContent.token.access_token).toBe('dual-access-token');
  });

  it('succeeds with warning when keyring write fails (exit 45 simulation) and file write succeeds', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({ status: 'missing' });
    vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValue(false); // Simulate exit status 45 write failure

    const registry = new RegistryManager();
    const account = registry.addOrUpdateAccount({
      email: 'keyring-fail@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'token-with-failed-keyring',
            refresh_token: 'ref',
          },
        },
      },
    });

    const switchResult = Switcher.switchAccount(account);
    expect(switchResult.antigravityUpdated).toBe(true);
    expect(switchResult.warnings).toBeDefined();
    expect(switchResult.warnings?.[0]).toMatch(/keyring/i);

    // Verify file half was written properly
    expect(fs.existsSync(Paths.antigravityTokenFile)).toBe(true);
    const diskContent = JSON.parse(fs.readFileSync(Paths.antigravityTokenFile, 'utf-8'));
    expect(diskContent.token.access_token).toBe('token-with-failed-keyring');
  });

  it('restores original token file byte-identically when switch fails midway', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({ status: 'missing' });
    vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValue(true);

    const originalContent = JSON.stringify(
      {
        auth_method: 'consumer',
        token: { access_token: 'original-token-state', refresh_token: 'orig-ref' },
      },
      null,
      2
    );
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, originalContent);

    const registry = new RegistryManager();
    const targetAccount = registry.addOrUpdateAccount({
      email: 'fail-switch@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: { access_token: 'new-token-that-will-fail-commit', refresh_token: 'new-ref' },
        },
      },
    });

    // Mock setActiveAccount to fail to trigger rollback
    const setActiveSpy = vi
      .spyOn(RegistryManager.prototype, 'setActiveAccount')
      .mockReturnValue(null);

    try {
      expect(() => Switcher.switchAccount(targetAccount)).toThrow(/rolled back/);

      // Verify token file was restored byte-identically
      const restoredContent = fs.readFileSync(Paths.antigravityTokenFile, 'utf-8');
      expect(restoredContent).toBe(originalContent);
    } finally {
      setActiveSpy.mockRestore();
    }
  });

  it('reports which half is fresher and flags failing keyring writes in doctor', async () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'stale-keyring',
          refresh_token: 'stale-ref',
          expiry: futureExpiry(HOUR_MS),
        },
      },
    });

    const freshFilePayload: KeychainPayload = {
      auth_method: 'consumer',
      token: {
        access_token: 'fresh-file',
        refresh_token: 'fresh-ref',
        expiry: futureExpiry(2 * HOUR_MS),
      },
    };
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(freshFilePayload));

    let output = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value: string) => {
      output += value;
    });

    try {
      await doctorCommand({ offline: true, json: true });
      const parsed = JSON.parse(output) as {
        data: { checks: Array<{ name: string; status: string; message: string }> };
      };
      const storeCheck = parsed.data.checks.find((c) => c.name === 'Antigravity Session Store');
      expect(storeCheck).toBeDefined();
      expect(storeCheck?.status).toBe('warn');
      expect(storeCheck?.message).toContain('Token file is fresher than system Keychain');
      expect(storeCheck?.message).toContain('Re-authenticate in Antigravity');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('handles writeAntigravityToken failure when file system write throws', () => {
    const parentDir = path.dirname(Paths.antigravityTokenFile);
    fs.mkdirSync(parentDir, { recursive: true });

    // Make target path a directory so writeFileAtomic fails
    const invalidFilePath = path.join(parentDir, 'nested-dir');
    fs.mkdirSync(invalidFilePath, { recursive: true });
    vi.spyOn(Paths, 'antigravityTokenFile', 'get').mockReturnValue(invalidFilePath);

    const result = writeAntigravityToken({
      auth_method: 'consumer',
      token: { access_token: 'test', refresh_token: 'ref' },
    });

    expect(result.ok).toBe(false);
    expect(result.fileWritten).toBe(false);
    expect(result.error).toMatch(/Failed to write token file/);
  });

  it('handles non-macOS platforms when reading token from file', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(false);

    const freshFilePayload: KeychainPayload = {
      auth_method: 'consumer',
      token: {
        access_token: 'non-mac-file-token',
        refresh_token: 'non-mac-refresh',
        expiry: '2026-08-24T18:00:00.000Z',
      },
    };
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(freshFilePayload));

    const result = readAntigravityToken();
    expect(result.status).toBe('found');
    expect(result.source).toBe('file');
    expect(result.payload?.token.access_token).toBe('non-mac-file-token');
  });

  it('breaks ties in favor of keyring when neither half has parseable expiry', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: {
          access_token: 'keyring-tie-token',
          refresh_token: 'ref',
          expiry: 'not-a-valid-date',
        },
      },
    });

    const filePayload: KeychainPayload = {
      auth_method: 'consumer',
      token: {
        access_token: 'file-tie-token',
        refresh_token: 'ref',
        expiry: 'not-a-valid-date-either',
      },
    };
    fs.mkdirSync(path.dirname(Paths.antigravityTokenFile), { recursive: true });
    fs.writeFileSync(Paths.antigravityTokenFile, JSON.stringify(filePayload));

    const result = readAntigravityToken();
    expect(result.status).toBe('found');
    expect(result.source).toBe('keyring');
    expect(result.payload?.token.access_token).toBe('keyring-tie-token');
  });
});
