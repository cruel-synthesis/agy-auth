import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/commands/doctor.js';
import { CliError } from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { generateSyntheticPrivateKey, setupTestEnvironment, TestEnv } from './test-utils.js';

describe('Doctor Diagnostic Command Comprehensive Suite', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

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

  it('reports warning for legacy accounts.json or legacy schemaVersion: 1 without failing', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // 1. Legacy accounts.json present
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

      // 2. Legacy schemaVersion: 1 inside registry.json
      fs.unlinkSync(legacyPath);
      fs.writeFileSync(
        Paths.registryFile,
        JSON.stringify({
          schemaVersion: 1,
          accounts: [
            {
              id: 'acc_leg2',
              email: 'leg2@example.com',
              authType: 'api-key',
              credentials: { apiKey: 'AIzaSy123' },
            },
          ],
        })
      );
      await doctorCommand({ offline: true, json: true });
    } finally {
      isSupportedSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('fails if registry has invalid Schema v2 structure, invalid credentials, or incompatible legacy schema', async () => {
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

    // 4. Schema v2 schema validation failure (missing settings or accounts)
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
          expiry: '2030-01-01T00:00:00.000Z',
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
});
