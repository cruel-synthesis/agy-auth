import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CREDENTIAL_FILE_SIZE } from '../src/core/credential-files.js';
import { CliError } from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { Storage } from '../src/core/storage.js';
import { Switcher } from '../src/core/switcher.js';
import { TestEnv, generateSyntheticPrivateKey, setupTestEnvironment } from './test-utils.js';

describe('Switcher Transactional State Machine & Rollback', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('switches accounts cleanly, updates external state, and returns sanitized SwitchResult with requiresShellUpdate: true', () => {
    const registry = new RegistryManager();

    // 1. Add API key profile
    const accApi = registry.addOrUpdateAccount({
      email: 'api@example.com',
      alias: 'gemini-key',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyTestKey123' },
      gcpProject: 'proj-gemini',
      model: 'gemini-2.5-pro',
    });

    const result = Switcher.switchAccount(accApi);
    expect(result.currentAccount.email).toBe('api@example.com');
    expect(result.currentAccount.id).toBe(accApi.id);
    expect(result.previousAccount).toBeNull();
    expect(result.antigravityUpdated).toBe(true);
    expect(result.requiresShellUpdate).toBe(true);

    // Verify Antigravity settings.json on disk
    expect(fs.existsSync(Paths.antigravitySettingsFile)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(Paths.antigravitySettingsFile, 'utf-8'));
    expect(settings.gcp?.project).toBe('proj-gemini');
    expect(settings.model).toBe('gemini-2.5-pro');

    // 2. Add and switch to Service Account profile
    const pem = generateSyntheticPrivateKey();
    const saPayload = {
      type: 'service_account' as const,
      project_id: 'sa-proj',
      private_key: pem,
      client_email: 'sa-acc@sa-proj.iam.gserviceaccount.com',
    };
    const accSa = registry.addOrUpdateAccount({
      email: 'sa-acc@sa-proj.iam.gserviceaccount.com',
      alias: 'sa-prod',
      authType: 'service-account',
      credentials: { serviceAccountKey: saPayload },
    });

    const resultSa = Switcher.switchAccount(accSa);
    expect(resultSa.currentAccount.id).toBe(accSa.id);
    expect(resultSa.previousAccount?.id).toBe(accApi.id);
    expect(resultSa.requiresShellUpdate).toBe(true);

    // Verify service account key was materialized to accounts directory
    const expectedSaFile = path.join(Paths.accountsDir, `${accSa.id}.json`);
    expect(fs.existsSync(expectedSaFile)).toBe(true);

    // 3. Add and switch to ADC profile (which also cleans gcp/model from settings.json)
    const customAdc = path.join(testEnv.dir, 'custom-adc.json');
    fs.writeFileSync(
      customAdc,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'c',
        client_secret: 's',
        refresh_token: 'r',
      })
    );
    const accAdc = registry.addOrUpdateAccount({
      email: 'adc-switch@example.com',
      authType: 'adc',
      credentials: { adcPath: customAdc },
    });

    const resultAdc = Switcher.switchAccount(accAdc);
    expect(resultAdc.adcUpdated).toBe(true);
    expect(fs.existsSync(Paths.gcloudAdcFile)).toBe(true);
    const cleanedSettings = JSON.parse(fs.readFileSync(Paths.antigravitySettingsFile, 'utf-8'));
    expect(cleanedSettings.gcp).toBeUndefined();
    expect(cleanedSettings.model).toBeUndefined();
  });

  it('returns the post-activation registry state in SwitchResult', () => {
    const registry = new RegistryManager();
    const account = registry.addOrUpdateAccount({
      email: 'result-state@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'synthetic-api-key' },
    });

    const result = Switcher.switchAccount(account);
    const persisted = new RegistryManager().getActiveAccount();

    expect(persisted).not.toBeNull();
    expect(result.currentAccount.updatedAt).toBe(persisted?.updatedAt);
    expect(result.currentAccount.lastUsedAt).toBe(persisted?.lastUsedAt);
  });

  it('fails preflight and performs no external mutations if credential payload is invalid or file missing', () => {
    const registry = new RegistryManager();

    // 1. Missing ADC file
    const badAdc = registry.addOrUpdateAccount({
      email: 'bad-adc@example.com',
      authType: 'adc',
      credentials: { adcPath: path.join(testEnv.dir, 'missing-adc.json') },
    });

    try {
      Switcher.switchAccount(badAdc);
      expect.unreachable('Should have thrown CliError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('invalid_profile_credentials');
      expect(cliErr.exitCode).toBe(1);
      expect(cliErr.message).toMatch(/File does not exist/);
    }

    // 2. Oversized ADC file
    const oversizedAdcPath = path.join(testEnv.dir, 'oversized-adc.json');
    fs.writeFileSync(
      oversizedAdcPath,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'c',
        client_secret: 's',
        refresh_token: 'r',
        padding: 'x'.repeat(MAX_CREDENTIAL_FILE_SIZE),
      })
    );
    const oversizedAdc = registry.addOrUpdateAccount({
      email: 'oversized-adc@example.com',
      authType: 'adc',
      credentials: { adcPath: oversizedAdcPath },
    });

    try {
      Switcher.switchAccount(oversizedAdc);
      expect.unreachable('Should have thrown CliError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('invalid_profile_credentials');
      expect(cliErr.exitCode).toBe(1);
      expect(cliErr.message).toMatch(/exceeds maximum size/);
    }

    // 3. Corrupted ADC file
    const corruptAdcPath = path.join(testEnv.dir, 'corrupt-adc.json');
    fs.writeFileSync(corruptAdcPath, '{ invalid json');
    const corruptAdc = registry.addOrUpdateAccount({
      email: 'corrupt-adc@example.com',
      authType: 'adc',
      credentials: { adcPath: corruptAdcPath },
    });

    try {
      Switcher.switchAccount(corruptAdc);
      expect.unreachable('Should have thrown CliError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('invalid_profile_credentials');
      expect(cliErr.exitCode).toBe(1);
      expect(cliErr.message).toContain('Invalid ADC credentials');
    }

    // 4. Non-registered account
    try {
      Switcher.switchAccount({
        id: 'acc_not_in_reg',
        email: 'ghost@example.com',
        authType: 'api-key',
        status: 'unverified',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect.unreachable('Should have thrown CliError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('account_not_found');
      expect(cliErr.exitCode).toBe(1);
      expect(cliErr.message).toContain('is not registered');
    }

    // 5. Invalid account ID format
    try {
      Switcher.switchAccount({
        id: 'acc with spaces!',
        email: 'invalid-id@example.com',
        authType: 'api-key',
        status: 'unverified',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect.unreachable('Should have thrown CliError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.exitCode).toBe(1);
    }

    // Verify active account was not changed
    const freshRegistry = new RegistryManager();
    expect(freshRegistry.getActiveAccount()).toBeNull();
  });

  it('switches successfully to an OAuth account whose Keychain payload has an empty refresh_token', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'old-access', refresh_token: '' },
      },
    });
    const writeSpy = vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValue(true);

    const registry = new RegistryManager();
    const oauthAcc = registry.addOrUpdateAccount({
      email: 'synthetic.user@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: { access_token: 'valid-access-token', refresh_token: '' },
        },
      },
    });

    const result = Switcher.switchAccount(oauthAcc);
    expect(result.currentAccount.id).toBe(oauthAcc.id);
    expect(result.requiresShellUpdate).toBe(true);
    expect(writeSpy).toHaveBeenCalled();
  });

  it('rolls back external settings and files if state mutation fails midway', () => {
    const registry = new RegistryManager();

    const acc1 = registry.addOrUpdateAccount({
      email: 'initial@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKeyInitial' },
      gcpProject: 'initial-proj',
    });
    Switcher.switchAccount(acc1);

    const acc2 = registry.addOrUpdateAccount({
      email: 'target@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKeyTarget' },
      gcpProject: 'target-proj',
    });

    // Simulate failure during setActiveAccount
    const setActiveSpy = vi
      .spyOn(RegistryManager.prototype, 'setActiveAccount')
      .mockReturnValue(null);

    try {
      expect(() => Switcher.switchAccount(acc2)).toThrow(/external changes were rolled back/);

      // Verify settings.json was rolled back to initial state
      const settings = JSON.parse(fs.readFileSync(Paths.antigravitySettingsFile, 'utf-8'));
      expect(settings.gcp?.project).toBe('initial-proj');
    } finally {
      setActiveSpy.mockRestore();
    }
  });

  it('aborts if Antigravity settings are replaced after the rollback snapshot', () => {
    if (process.platform === 'win32') return;

    const originalSettings = { trustedWorkspaces: ['/safe/workspace'] };
    const externalSettings = path.join(testEnv.dir, 'replacement-settings.json');
    fs.writeFileSync(Paths.antigravitySettingsFile, JSON.stringify(originalSettings));
    fs.writeFileSync(externalSettings, JSON.stringify({ injected: true }));

    const registry = new RegistryManager();
    const account = registry.addOrUpdateAccount({
      email: 'settings-race@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'synthetic-api-key' },
      gcpProject: 'expected-project',
    });

    const createBackup = Storage.createBackup.bind(Storage);
    let replaced = false;
    vi.spyOn(Storage, 'createBackup').mockImplementation((sourcePath, prefix) => {
      const backupPath = createBackup(sourcePath, prefix);
      if (!replaced && path.resolve(sourcePath) === path.resolve(Paths.antigravitySettingsFile)) {
        replaced = true;
        fs.unlinkSync(Paths.antigravitySettingsFile);
        fs.symlinkSync(externalSettings, Paths.antigravitySettingsFile);
      }
      return backupPath;
    });

    expect(() => Switcher.switchAccount(account)).toThrow(/settings.*changed/i);
    expect(new RegistryManager().getActiveAccount()).toBeNull();
    expect(fs.lstatSync(Paths.antigravitySettingsFile).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(Paths.antigravitySettingsFile, 'utf-8'))).toEqual(
      originalSettings
    );
    expect(JSON.parse(fs.readFileSync(externalSettings, 'utf-8'))).toEqual({ injected: true });
  });

  it('handles Keychain token backup and restoration for OAuth accounts', () => {
    const supportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'old-access', refresh_token: 'old-refresh' },
      },
    });
    const writeSpy = vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValue(true);

    try {
      const registry = new RegistryManager();
      const oauthAcc = registry.addOrUpdateAccount({
        email: 'oauth-user@example.com',
        authType: 'oauth',
        credentials: {
          keychainPayload: {
            auth_method: 'consumer',
            token: { access_token: 'ya29.oauth-tok', refresh_token: '1//refresh-tok' },
          },
        },
      });

      const result = Switcher.switchAccount(oauthAcc);
      expect(result.currentAccount.id).toBe(oauthAcc.id);
      expect(result.requiresShellUpdate).toBe(true);
      // KeychainManager.writeAgyToken returns false -> switch still succeeds with warning because file store succeeded
      writeSpy.mockReturnValue(false);
      const warnResult = Switcher.switchAccount(oauthAcc);
      expect(warnResult.currentAccount.id).toBe(oauthAcc.id);
      expect(warnResult.warnings).toBeDefined();
      expect(warnResult.warnings?.[0]).toMatch(/keyring/i);
    } finally {
      supportedSpy.mockRestore();
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('aborts an OAuth switch before mutation when the existing Keychain item cannot be read', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'error',
      message: 'synthetic Keychain read failure',
    });
    const writeSpy = vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValue(true);

    const registry = new RegistryManager();
    const account = registry.addOrUpdateAccount({
      email: 'unreadable-keychain@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: { access_token: 'new-access-token', refresh_token: '' },
        },
      },
    });

    expect(() => Switcher.switchAccount(account)).toThrow(/cannot safely snapshot/i);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(Paths.antigravityTokenFile)).toBe(false);
    expect(new RegistryManager().getActiveAccount()).toBeNull();
  });

  it('reports a failed Keychain restore instead of claiming rollback succeeded', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'old-access-token', refresh_token: '' },
      },
    });
    vi.spyOn(KeychainManager, 'writeAgyToken').mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.spyOn(RegistryManager.prototype, 'setActiveAccount').mockReturnValue(null);

    const registry = new RegistryManager();
    const account = registry.addOrUpdateAccount({
      email: 'failed-keychain-restore@example.com',
      authType: 'oauth',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: { access_token: 'new-access-token', refresh_token: '' },
        },
      },
    });

    expect(() => Switcher.switchAccount(account)).toThrow(
      /Rollback also failed: Failed to restore the Antigravity Keychain item/
    );
  });

  it('rejects a replaced rollback backup instead of restoring unrelated content', () => {
    if (process.platform === 'win32') return;

    const registry = new RegistryManager();
    const initial = registry.addOrUpdateAccount({
      email: 'rollback-initial@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'initial-api-key' },
      gcpProject: 'initial-project',
    });
    Switcher.switchAccount(initial);

    const target = registry.addOrUpdateAccount({
      email: 'rollback-target@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'target-api-key' },
      gcpProject: 'target-project',
    });
    const externalFile = path.join(testEnv.dir, 'replacement-backup.json');
    fs.writeFileSync(externalFile, JSON.stringify({ injected: true }));

    const createBackup = Storage.createBackup.bind(Storage);
    let settingsBackup: string | null = null;
    vi.spyOn(Storage, 'createBackup').mockImplementation((sourcePath, prefix) => {
      const backupPath = createBackup(sourcePath, prefix);
      if (path.resolve(sourcePath) === path.resolve(Paths.antigravitySettingsFile)) {
        settingsBackup = backupPath;
      }
      return backupPath;
    });
    vi.spyOn(RegistryManager.prototype, 'setActiveAccount').mockImplementation(() => {
      if (!settingsBackup) throw new Error('Settings backup was not captured.');
      fs.unlinkSync(settingsBackup);
      fs.symlinkSync(externalFile, settingsBackup);
      return null;
    });

    expect(() => Switcher.switchAccount(target)).toThrow(/Rollback also failed:.*backup.*changed/i);
    expect(JSON.parse(fs.readFileSync(Paths.antigravitySettingsFile, 'utf-8'))).toEqual({
      gcp: { project: 'target-project' },
    });
    expect(JSON.parse(fs.readFileSync(externalFile, 'utf-8'))).toEqual({ injected: true });
  });

  it('handles switching to default ADC path and preserving custom settings fields', () => {
    const registry = new RegistryManager();
    // Default ADC file
    fs.writeFileSync(
      Paths.gcloudAdcFile,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'c',
        client_secret: 's',
        refresh_token: 'r',
      })
    );
    const adcAcc = registry.addOrUpdateAccount({
      email: 'default-adc@example.com',
      authType: 'adc',
      credentials: { adcPath: Paths.gcloudAdcFile },
    });

    // Antigravity settings with custom fields in gcp
    fs.writeFileSync(
      Paths.antigravitySettingsFile,
      JSON.stringify({
        gcp: { project: 'proj', customField: 'preserve_me' },
      })
    );

    const result = Switcher.switchAccount(adcAcc);
    expect(result.adcUpdated).toBe(true);
    const settings = JSON.parse(fs.readFileSync(Paths.antigravitySettingsFile, 'utf-8'));
    expect(settings.gcp.customField).toBe('preserve_me');
    expect(settings.gcp.project).toBeUndefined();
  });

  it('combines rollback errors when rollback actions fail', () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'comb-roll@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });

    // Mock setActiveAccount to fail and unlinkSync in rollback to fail only for settings
    const setActiveSpy = vi
      .spyOn(RegistryManager.prototype, 'setActiveAccount')
      .mockReturnValue(null);
    const originalUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((targetPath: fs.PathLike) => {
      if (typeof targetPath === 'string' && targetPath.includes('settings.json')) {
        throw new Error('Disk unwritable during rollback');
      }
      return originalUnlink(targetPath);
    });

    try {
      expect(() => Switcher.switchAccount(acc)).toThrow(/Rollback also failed/);
    } finally {
      setActiveSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });
});
