import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Discovery } from '../src/core/discovery.js';
import { Paths } from '../src/core/paths.js';
import { generateSyntheticPrivateKey, setupTestEnvironment, TestEnv } from './test-utils.js';

describe('Paths and Discovery Subsystems', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('resolves default and overridden paths correctly', () => {
    expect(Paths.authHome).toBe(path.resolve(testEnv.dir, '.agy-auth'));
    expect(Paths.registryFile).toBe(path.join(Paths.authHome, 'registry.json'));
    expect(Paths.accountsDir).toBe(path.join(Paths.authHome, 'accounts'));
    expect(Paths.backupsDir).toBe(path.join(Paths.authHome, 'backups'));
    expect(Paths.antigravitySettingsFile).toBe(
      path.join(testEnv.dir, '.gemini', 'antigravity-cli', 'settings.json')
    );
    expect(Paths.gcloudAdcFile).toBe(
      path.join(testEnv.dir, '.config', 'gcloud', 'application_default_credentials.json')
    );
    expect(Paths.gcloudConfigDir).toBe(path.join(testEnv.dir, '.config', 'gcloud'));
    expect(Paths.antigravityCliDir).toBe(path.join(testEnv.dir, '.gemini', 'antigravity-cli'));

    // Test env overrides
    const customSettings = path.join(testEnv.dir, 'custom-settings.json');
    const customAdc = path.join(testEnv.dir, 'custom-adc-dir', 'custom-adc.json');
    process.env.AGY_SETTINGS_FILE = customSettings;
    process.env.AGY_GCLOUD_ADC_FILE = customAdc;
    try {
      expect(Paths.antigravitySettingsFile).toBe(path.resolve(customSettings));
      expect(Paths.gcloudAdcFile).toBe(path.resolve(customAdc));
      expect(Paths.gcloudConfigDir).toBe(path.dirname(path.resolve(customAdc)));
    } finally {
      delete process.env.AGY_SETTINGS_FILE;
      delete process.env.AGY_GCLOUD_ADC_FILE;
    }
  });

  it('rejects symbolic links or non-directory files in data directories', () => {
    if (process.platform !== 'win32') {
      const realDir = path.join(testEnv.dir, 'real-backups');
      fs.mkdirSync(realDir, { recursive: true });

      // Replace backupsDir with symlink
      fs.rmSync(Paths.backupsDir, { recursive: true, force: true });
      fs.symlinkSync(realDir, Paths.backupsDir);

      expect(() => Paths.ensureDirectories()).toThrow(/must not be a symbolic link/);
    }

    // Replace accountsDir with regular file
    fs.rmSync(Paths.accountsDir, { recursive: true, force: true });
    fs.writeFileSync(Paths.accountsDir, 'plain-file-not-dir');
    expect(() => Paths.ensureDirectories()).toThrow(/must be a directory/);
  });

  it('reads Antigravity settings cleanly and returns null on missing or malformed JSON', () => {
    expect(Discovery.readAntigravitySettings()).toBeNull();

    // Malformed JSON
    fs.writeFileSync(Paths.antigravitySettingsFile, '{ bad json');
    expect(Discovery.readAntigravitySettings()).toBeNull();

    // Valid settings
    fs.writeFileSync(
      Paths.antigravitySettingsFile,
      JSON.stringify({
        gcp: { project: 'disc-proj', location: 'europe-west1' },
        model: 'gemini-2.5-flash',
      })
    );

    const settings = Discovery.readAntigravitySettings();
    expect(settings?.gcp?.project).toBe('disc-proj');
    expect(settings?.model).toBe('gemini-2.5-flash');
  });

  it('discovers ADC credentials for Service Account and OAuth users', () => {
    expect(Discovery.discoverFromAdc()).toBeNull();

    // 1. Service Account ADC
    const pem = generateSyntheticPrivateKey();
    fs.writeFileSync(
      Paths.gcloudAdcFile,
      JSON.stringify({
        type: 'service_account',
        project_id: 'disc-sa-proj',
        client_email: 'sa-disc@disc-sa-proj.iam.gserviceaccount.com',
        private_key: pem,
      })
    );

    const saDiscovered = Discovery.discoverFromAdc();
    expect(saDiscovered?.email).toBe('sa-disc@disc-sa-proj.iam.gserviceaccount.com');
    expect(saDiscovered?.gcpProject).toBe('disc-sa-proj');

    // 2. User OAuth ADC
    fs.writeFileSync(
      Paths.gcloudAdcFile,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'cs',
        refresh_token: 'tok',
        account: 'user-oauth@example.com',
        quota_project_id: 'quota-proj',
      })
    );

    const userDiscovered = Discovery.discoverFromAdc();
    expect(userDiscovered?.email).toBe('user-oauth@example.com');
    expect(userDiscovered?.gcpProject).toBe('quota-proj');
  });
});
