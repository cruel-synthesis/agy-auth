import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/commands/doctor.js';
import { CliError } from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import {
  futureExpiry,
  generateSyntheticPrivateKey,
  installNativeStoreDouble,
  type NativeStoreDouble,
  setupTestEnvironment,
  TestEnv,
} from './test-utils.js';

describe('Doctor Diagnostic Command Comprehensive Suite', () => {
  let testEnv: TestEnv;
  let nativeStore: NativeStoreDouble | null = null;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
    nativeStore = null;
  });

  afterEach(() => {
    nativeStore?.restore();
    nativeStore = null;
    testEnv.cleanup();
  });

  /** Diagnostics always inspect the native store; give it a controlled stand-in. */
  const useEmptyNativeStore = (): void => {
    nativeStore = installNativeStoreDouble({ supported: false });
  };

  it('reports pass when storage and files are pristine or uninitialized', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'missing',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await doctorCommand({ offline: true, json: false });
      await doctorCommand({ offline: true, json: true });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      isSupportedSpy.mockRestore();
      readSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('warns about a legacy accounts.json or a schema 2 registry, and fails on one it cannot read', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const lastJson = () => {
      const calls = logSpy.mock.calls;
      return JSON.parse(String(calls[calls.length - 1][0]));
    };

    try {
      // 1. Legacy accounts.json present alongside a current registry.
      const legacyPath = path.join(Paths.authHome, 'accounts.json');
      fs.writeFileSync(
        legacyPath,
        JSON.stringify({
          schemaVersion: 1,
          accounts: [
            {
              id: 'acc_leg',
              email: 'leg@example.com',
              authType: 'api-key',
              credentials: { apiKey: 'AIzaSy123' },
            },
          ],
        })
      );
      await doctorCommand({ offline: true, json: true });
      const legacy = lastJson().data.checks.find(
        (c: { name: string }) => c.name === 'Registry Schema & Integrity'
      );
      expect(legacy.status).toBe('warn');
      // Copying it into place is no longer a way in: schema 1 is not read.
      expect(legacy.message).toContain('agy-auth add');
      expect(legacy.message).not.toMatch(/copy it/);
      fs.unlinkSync(legacyPath);

      // 2. A schema 2 registry is readable, so it warns rather than failing.
      const v2Account = {
        id: 'acc_v2',
        email: 'v2@example.com',
        authType: 'api-key',
        status: 'valid',
        credentials: { apiKey: 'AIzaSy123' },
        createdAt: 1,
        updatedAt: 2,
      };
      fs.writeFileSync(
        Paths.registryFile,
        JSON.stringify({
          schemaVersion: 2,
          activeAccountId: null,
          previousAccountId: null,
          accounts: [v2Account],
          settings: { defaultLocation: 'global' },
        })
      );
      await doctorCommand({ offline: true, json: true });
      const warned = lastJson().data.checks.find(
        (c: { name: string }) => c.name === 'Registry Schema & Integrity'
      );
      expect(warned.status).toBe('warn');
      expect(warned.message).toMatch(/schema 2/);

      // 3. A schema this build cannot read is reported as a failure, by name.
      fs.writeFileSync(
        Paths.registryFile,
        JSON.stringify({ schemaVersion: 1, accounts: [v2Account] })
      );
      const thrown = await doctorCommand({ offline: true, json: true }).catch((e) => e);
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).message).toMatch(/One or more diagnostics checks failed/);
      const failed = (
        (thrown as CliError).details.checks as { name: string; status: string; message: string }[]
      ).find((c) => c.name === 'Registry Schema & Integrity');
      expect(failed?.status).toBe('fail');
      expect(failed?.message).toMatch(/Unsupported registry schema version 1/);
    } finally {
      isSupportedSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('fails if registry has invalid Schema v2 structure, invalid credentials, or incompatible legacy schema', async () => {
    useEmptyNativeStore();
    // 1. Incompatible legacy schema (accounts is not array)
    fs.writeFileSync(
      Paths.registryFile,
      JSON.stringify({ schemaVersion: 1, accounts: 'not-array' })
    );
    await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);

    // 2. Schema v2 with invalid account credentials
    fs.writeFileSync(
      Paths.registryFile,
      JSON.stringify({
        schemaVersion: 2,
        activeAccountId: null,
        previousAccountId: null,
        accounts: [
          {
            id: 'acc_bad_creds',
            email: 'bad@example.com',
            authType: 'api-key',
            status: 'valid',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            credentials: {}, // missing apiKey
          },
        ],
        settings: { defaultLocation: 'us-central1' },
      })
    );
    await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);

    // 3. Schema v2 with duplicate identities violates cross-record invariants
    const duplicateBase = {
      email: 'duplicate@example.com',
      authType: 'api-key',
      status: 'valid',
      credentials: { apiKey: 'synthetic-key' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(
      Paths.registryFile,
      JSON.stringify({
        schemaVersion: 2,
        activeAccountId: null,
        previousAccountId: null,
        accounts: [
          { ...duplicateBase, id: 'duplicate_1' },
          { ...duplicateBase, id: 'duplicate_2' },
        ],
        settings: { defaultLocation: 'us-central1' },
      })
    );
    await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);

    // 4. A current registry that fails its schema names the field, not a JSON dump.
    fs.writeFileSync(
      Paths.registryFile,
      JSON.stringify({
        schemaVersion: 3,
        activeAccountId: null,
        previousAccountId: null,
        accounts: [{ ...duplicateBase, id: 'bad_email', email: 'not-an-email' }],
        settings: {},
      })
    );
    const thrown = await doctorCommand({ offline: true, json: true }).catch((e) => e);
    const schemaCheck = (
      (thrown as CliError).details.checks as { name: string; message: string }[]
    ).find((c) => c.name === 'Registry Schema & Integrity');
    expect(schemaCheck?.message).toContain('accounts.0.email: invalid email');

    // 5. Schema v2 schema validation failure (missing settings or accounts)
    fs.writeFileSync(
      Paths.registryFile,
      JSON.stringify({
        schemaVersion: 2,
        accounts: 'bad',
      })
    );
    await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);
  });

  it('reports warning for non-0700 storage permissions on POSIX', async () => {
    useEmptyNativeStore();
    if (process.platform === 'win32') return;

    fs.mkdirSync(Paths.authHome, { recursive: true, mode: 0o755 });
    fs.chmodSync(Paths.authHome, 0o755);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await doctorCommand({ offline: true, json: false });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports insecure registry permissions on POSIX', async () => {
    useEmptyNativeStore();
    if (process.platform === 'win32') return;

    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'permissions@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'synthetic-key' },
    });
    fs.chmodSync(Paths.registryFile, 0o644);

    let output = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value: string) => {
      output += value;
    });
    try {
      await doctorCommand({ offline: true, json: true });
      const result = JSON.parse(output) as { data: { checks: Array<Record<string, string>> } };
      expect(result.data.checks).toContainEqual(
        expect.objectContaining({
          name: 'Registry File Permissions',
          status: 'warn',
        })
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('fails if authHome is a symlink or not a directory', async () => {
    useEmptyNativeStore();
    if (process.platform === 'win32') return;

    const realDir = path.join(testEnv.dir, 'real-home');
    fs.mkdirSync(realDir, { recursive: true });
    fs.rmSync(Paths.authHome, { recursive: true, force: true });
    fs.symlinkSync(realDir, Paths.authHome);

    await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);

    fs.unlinkSync(Paths.authHome);
    fs.writeFileSync(Paths.authHome, 'not a dir');
    await expect(doctorCommand({ offline: true, json: false })).rejects.toThrow(CliError);
  });

  it('fails if registry is a symlink or invalid JSON', async () => {
    useEmptyNativeStore();
    fs.mkdirSync(Paths.authHome, { recursive: true });

    if (process.platform !== 'win32') {
      const realReg = path.join(testEnv.dir, 'real-reg.json');
      fs.writeFileSync(realReg, '{}');
      fs.symlinkSync(realReg, Paths.registryFile);
      await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);
      fs.rmSync(Paths.registryFile, { force: true });
    }

    fs.writeFileSync(Paths.registryFile, '{ invalid json');
    await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);
  });

  it('fails if registry.json is replaced by a symbolic link during diagnostics', async () => {
    useEmptyNativeStore();
    if (process.platform === 'win32') return;

    const registryFile = Paths.registryFile;
    const externalRegistry = path.join(testEnv.dir, 'doctor-race-registry.json');
    const emptyRegistry = {
      schemaVersion: 2,
      activeAccountId: null,
      previousAccountId: null,
      accounts: [],
      settings: { defaultLocation: 'global' },
    };
    fs.writeFileSync(registryFile, JSON.stringify(emptyRegistry));
    fs.writeFileSync(externalRegistry, JSON.stringify(emptyRegistry));

    const originalLstat = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, options) => {
      const stat = originalLstat(filePath, options as never);
      if (path.resolve(String(filePath)) === path.resolve(registryFile)) {
        fs.unlinkSync(registryFile);
        fs.symlinkSync(externalRegistry, registryFile);
      }
      return stat as never;
    });

    try {
      await expect(doctorCommand({ offline: true, json: true })).rejects.toMatchObject({
        code: 'doctor_failed',
        details: {
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: 'Registry Schema & Integrity',
              status: 'fail',
            }),
          ]),
        },
      });
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('evaluates Keychain, Antigravity settings, ADC, and network reachability', async () => {
    // 1. Keychain found & settings valid & ADC valid & Network success
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'ya29.tok', refresh_token: '1//ref' },
      },
    });

    const settingsDir = path.dirname(Paths.antigravitySettingsFile);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(Paths.antigravitySettingsFile, JSON.stringify({ gcp: { project: 'p' } }));

    const adcDir = path.dirname(Paths.gcloudAdcFile);
    fs.mkdirSync(adcDir, { recursive: true });
    fs.writeFileSync(
      Paths.gcloudAdcFile,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'c',
        client_secret: 's',
        refresh_token: 'r',
      })
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await doctorCommand({ offline: false, json: false });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      isSupportedSpy.mockRestore();
      readSpy.mockRestore();
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }

    // 2. Network error in online mode reports warning without failing
    useEmptyNativeStore();
    const fetchErrSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network offline'));
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await doctorCommand({ offline: false, json: true });
    } finally {
      fetchErrSpy.mockRestore();
      logSpy2.mockRestore();
    }
  });

  it('fails if Keychain returns status error or settings.json is corrupted', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'error',
      message: 'Keychain corrupted',
    });

    try {
      await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(CliError);
    } finally {
      isSupportedSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('fails if Antigravity settings.json is a symbolic link', async () => {
    useEmptyNativeStore();
    if (process.platform === 'win32') return;

    const realSettings = path.join(testEnv.dir, 'real-settings.json');
    fs.writeFileSync(realSettings, JSON.stringify({ gcp: { project: 'outside-profile' } }));
    fs.mkdirSync(path.dirname(Paths.antigravitySettingsFile), { recursive: true });
    fs.symlinkSync(realSettings, Paths.antigravitySettingsFile);

    await expect(doctorCommand({ offline: true, json: true })).rejects.toMatchObject({
      code: 'doctor_failed',
      details: {
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'Antigravity Settings File',
            status: 'fail',
            message: expect.stringContaining('must be a regular file'),
          }),
        ]),
      },
    });
  });

  it('fails if settings.json is replaced by a symbolic link during diagnostics', async () => {
    useEmptyNativeStore();
    if (process.platform === 'win32') return;

    const settingsFile = Paths.antigravitySettingsFile;
    const externalSettings = path.join(testEnv.dir, 'doctor-race-settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ model: 'original-model' }));
    fs.writeFileSync(externalSettings, JSON.stringify({ model: 'linked-model' }));

    const originalLstat = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, options) => {
      const stat = originalLstat(filePath, options as never);
      if (path.resolve(String(filePath)) === path.resolve(settingsFile)) {
        fs.unlinkSync(settingsFile);
        fs.symlinkSync(externalSettings, settingsFile);
      }
      return stat as never;
    });

    try {
      await expect(doctorCommand({ offline: true, json: true })).rejects.toMatchObject({
        code: 'doctor_failed',
        details: {
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: 'Antigravity Settings File',
              status: 'fail',
            }),
          ]),
        },
      });
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('warns when the token file works but the macOS Keychain cannot be read', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'error',
      message: 'synthetic Keychain access failure',
    });
    fs.writeFileSync(
      Paths.antigravityTokenFile,
      JSON.stringify({
        auth_method: 'consumer',
        token: {
          access_token: 'synthetic-file-token',
          refresh_token: '',
          expiry: futureExpiry(),
        },
      })
    );

    let output = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value: string) => {
      output += value;
    });
    try {
      await doctorCommand({ offline: true, json: true });
      const result = JSON.parse(output) as { data: { checks: Array<Record<string, string>> } };
      expect(result.data.checks).toContainEqual(
        expect.objectContaining({
          name: 'Antigravity Session Store',
          status: 'warn',
          message: expect.stringContaining('synthetic Keychain access failure'),
        })
      );
    } finally {
      isSupportedSpy.mockRestore();
      readSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('warns when the Keychain works but the Antigravity token file cannot be read', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'synthetic-keychain-token', refresh_token: '' },
      },
    });
    fs.writeFileSync(Paths.antigravityTokenFile, '{ malformed token file');

    let output = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value: string) => {
      output += value;
    });
    try {
      await doctorCommand({ offline: true, json: true });
      const result = JSON.parse(output) as { data: { checks: Array<Record<string, string>> } };
      expect(result.data.checks).toContainEqual(
        expect.objectContaining({
          name: 'Antigravity Session Store',
          status: 'warn',
          message: expect.stringContaining('token file'),
        })
      );
    } finally {
      isSupportedSpy.mockRestore();
      readSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('warns when the selected Antigravity session has expired', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'missing',
    });
    const expiry = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      Paths.antigravityTokenFile,
      JSON.stringify({
        auth_method: 'consumer',
        token: {
          access_token: 'expired-file-token',
          refresh_token: '',
          expiry,
        },
      })
    );

    let output = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value: string) => {
      output += value;
    });
    try {
      await doctorCommand({ offline: true, json: true });
      const result = JSON.parse(output) as { data: { checks: Array<Record<string, string>> } };
      expect(result.data.checks).toContainEqual(
        expect.objectContaining({
          name: 'Antigravity Session Store',
          status: 'warn',
          message: expect.stringContaining(`expired at ${expiry}`),
        })
      );
    } finally {
      isSupportedSpy.mockRestore();
      readSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
