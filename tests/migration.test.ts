import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  migrateExportDocument,
  migrateLegacyAccount,
  migrateRegistry,
} from '../src/core/migration.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { Storage } from '../src/core/storage.js';
import { TestEnv, generateSyntheticPrivateKey, setupTestEnvironment } from './test-utils.js';

describe('Schema Migration and Timestamp Monotonicity', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('migrates a Schema v1 registry to the current schema with full field preservation', () => {
    const pem = generateSyntheticPrivateKey();
    const v1Data = {
      version: 1,
      activeAccountId: 'acc_1',
      accounts: [
        {
          id: 'acc_1',
          email: 'user1@example.com',
          alias: 'main',
          authType: 'oauth',
          credentials: {
            accessToken: 'ya29.old-token',
            refreshToken: '1//old-refresh',
            tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
        {
          id: 'acc_2',
          email: 'api-alias-only',
          authType: 'api-key',
          credentials: {
            apiKey: 'AIzaSyFakeKey1234567890',
          },
          createdAt: 2000,
          updatedAt: 2000,
        },
        {
          id: 'acc_3',
          email: 'sa@proj.iam.gserviceaccount.com',
          authType: 'service-account',
          credentials: {
            serviceAccountKey: {
              type: 'service_account',
              project_id: 'proj',
              client_email: 'sa@proj.iam.gserviceaccount.com',
              private_key: pem,
            },
          },
          createdAt: 3000,
          updatedAt: 3000,
        },
        {
          id: 'acc_4',
          email: 'adc@example.com',
          authType: 'adc',
          credentials: {
            adcPath: '/path/to/adc.json',
          },
          createdAt: 4000,
          updatedAt: 4000,
        },
      ],
      settings: {
        defaultModel: 'gemini-2.5-flash',
        defaultLocation: 'us-central1',
      },
    };

    const { registry, migrated } = migrateRegistry(v1Data);
    expect(migrated).toBe(true);
    expect(registry.schemaVersion).toBe(3);
    expect(registry.activeAccountId).toBe('acc_1');
    expect(registry.accounts.length).toBe(4);
    expect(registry.accounts[0].authType).toBe('oauth');
    expect(registry.accounts[0]?.credentials?.keychainPayload?.token.access_token).toBe(
      'ya29.old-token'
    );

    // Legacy label converted to alias and local.invalid email
    expect(registry.accounts[1].alias).toBe('api-alias-only');
    expect(registry.accounts[1].email).toBe('acc_2@local.invalid');

    // Settings preserved
    expect(registry.settings.defaultModel).toBe('gemini-2.5-flash');
    expect(registry.settings.defaultLocation).toBe('us-central1');
  });

  it('upgrades v2 registries without inventing a credential source', () => {
    const v2Data = {
      schemaVersion: 2,
      activeAccountId: 'acc_native',
      previousAccountId: null,
      accounts: [
        {
          id: 'acc_native',
          email: 'native@example.com',
          authType: 'oauth',
          status: 'valid',
          credentials: {
            keychainPayload: {
              auth_method: 'consumer',
              token: { access_token: 'a', refresh_token: 'r' },
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: 'acc_key',
          email: 'key@example.com',
          authType: 'api-key',
          status: 'valid',
          credentials: { apiKey: 'AIzaSyExample' },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      settings: { defaultLocation: 'global' },
    };

    const { registry, migrated } = migrateRegistry(v2Data);

    expect(migrated).toBe(true);
    expect(registry.schemaVersion).toBe(3);

    // Where the credentials came from is unrecoverable for pre-existing
    // profiles, so it is recorded as unknown rather than assumed.
    const native = registry.accounts.find((a) => a.id === 'acc_native');
    expect(native?.credentialSource).toBe('unknown');

    // Provenance is an OAuth concept; other auth types do not gain one.
    const key = registry.accounts.find((a) => a.id === 'acc_key');
    expect(key?.credentialSource).toBeUndefined();
  });

  it('keeps a recorded credential source through a v3 round trip', () => {
    const v3Data = {
      schemaVersion: 3,
      activeAccountId: null,
      previousAccountId: null,
      accounts: [
        {
          id: 'acc_custom',
          email: 'custom@example.com',
          authType: 'oauth',
          status: 'valid',
          credentialSource: 'custom-client',
          oauthClientId: 'client-abc.apps.googleusercontent.com',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      settings: { defaultLocation: 'global' },
    };

    const { registry, migrated } = migrateRegistry(v3Data);

    expect(migrated).toBe(false);
    expect(registry.accounts[0].credentialSource).toBe('custom-client');
    expect(registry.accounts[0].oauthClientId).toBe('client-abc.apps.googleusercontent.com');
  });

  it('migrates v1 export documents to the current format and handles invalid documents', () => {
    const pem = generateSyntheticPrivateKey();
    const v1Export = {
      kind: 'agy-auth-profile-export',
      formatVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      includesSecrets: true,
      accounts: [
        {
          id: 'acc_exp_1',
          email: 'exp@example.com',
          authType: 'service-account',
          credentials: {
            serviceAccountKey: {
              type: 'service_account',
              project_id: 'p',
              client_email: 'exp@example.com',
              private_key: pem,
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    };

    const migrated = migrateExportDocument(v1Export);
    expect(migrated.kind).toBe('agy-auth-export');
    expect(migrated.formatVersion).toBe(3);
    expect(migrated.accounts.length).toBe(1);
    expect(migrated.accounts[0].email).toBe('exp@example.com');

    // Invalid non-object export document
    expect(() => migrateExportDocument(null)).toThrow(/root must be an object/);

    // Unsupported formatVersion
    expect(() => migrateExportDocument({ kind: 'unknown-export', formatVersion: 99 })).toThrow(
      /Unsupported export document format/
    );
  });

  it('still imports v2 export documents written before provenance existed', () => {
    const v2Export = {
      kind: 'agy-auth-export',
      formatVersion: 2,
      registrySchemaVersion: 2,
      exportedAt: '2026-01-01T00:00:00.000Z',
      includesSecrets: false,
      accounts: [
        {
          id: 'acc_v2',
          email: 'v2@example.com',
          authType: 'oauth',
          status: 'valid',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    };

    const migrated = migrateExportDocument(v2Export);

    expect(migrated.formatVersion).toBe(3);
    expect(migrated.registrySchemaVersion).toBe(3);
    expect(migrated.exportedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(migrated.accounts[0].credentialSource).toBe('unknown');
  });

  it('rejects legacy accounts with missing or unsupported authType without defaulting', () => {
    const missingAuthType = {
      id: 'acc_invalid',
      email: 'bad@example.com',
      credentials: { apiKey: 'key' },
    };

    expect(() => migrateLegacyAccount(missingAuthType)).toThrow(/missing or unsupported authType/);

    const unsupportedAuthType = {
      id: 'acc_invalid2',
      email: 'bad2@example.com',
      authType: 'oidc-token',
      credentials: {},
    };

    expect(() => migrateLegacyAccount(unsupportedAuthType)).toThrow(
      /missing or unsupported authType/
    );

    // Invalid email that is not an alias
    expect(() =>
      migrateLegacyAccount({
        id: 'acc_bad_email',
        email: 'not an email and not an alias!!',
        authType: 'api-key',
        credentials: { apiKey: 'k' },
      })
    ).toThrow(/invalid email/);
  });

  it('aborts migration and leaves original registry untouched if backup creation fails', () => {
    const v1Data = {
      version: 1,
      accounts: [
        {
          id: 'acc_1',
          email: 'test@example.com',
          authType: 'api-key',
          credentials: { apiKey: 'AIzaSy12345' },
        },
      ],
    };

    fs.writeFileSync(Paths.registryFile, JSON.stringify(v1Data));

    // Mock Storage.createBackup to return null (failure)
    const backupSpy = vi.spyOn(Storage, 'createBackup').mockReturnValue(null);

    try {
      expect(() => new RegistryManager()).toThrow(/Could not create a migration backup/);

      // Verify original file on disk is still raw v1
      const rawAfter = JSON.parse(fs.readFileSync(Paths.registryFile, 'utf-8'));
      expect(rawAfter.version).toBe(1);
    } finally {
      backupSpy.mockRestore();
    }
  });

  it('enforces strictly monotonic updatedAt timestamps even with frozen or backward clock', async () => {
    const registry = new RegistryManager();

    const initialNow = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(initialNow);

    const acc = registry.addOrUpdateAccount({
      email: 'monotonic@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyTestKey' },
    });
    expect(acc.updatedAt).toBe(initialNow);

    // Freeze clock (time does not advance)
    registry.setAlias(acc.id, 'alias1');
    const acc1 = registry.findAccount(acc.id);
    expect(acc1?.updatedAt).toBe(initialNow + 1);

    // Move clock backward
    vi.spyOn(Date, 'now').mockReturnValue(initialNow - 10000);
    registry.setProject(acc.id, 'my-gcp-proj', 'us-central1');
    const acc2 = registry.findAccount(acc.id);
    expect(acc2?.updatedAt).toBe(initialNow + 2);

    vi.restoreAllMocks();
  });

  it('clears stale verification when replacement credentials reset a profile', () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'replacement@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'old-synthetic-key' },
      status: 'valid',
      verification: {
        checkedAt: Date.now(),
        source: 'remote',
        message: 'old key verified',
      },
    });

    const updated = registry.addOrUpdateAccount({
      email: 'replacement@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'new-synthetic-key' },
      status: 'unverified',
    });

    expect(updated.status).toBe('unverified');
    expect(updated.verification).toBeUndefined();
  });
});
