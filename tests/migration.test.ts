import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateExportDocument, migrateRegistry } from '../src/core/migration.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { Storage } from '../src/core/storage.js';
import { setupTestEnvironment, TestEnv } from './test-utils.js';

/** A schema 2 registry as the first release wrote one. */
function schema2Registry() {
  return {
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
}

describe('Schema Migration and Timestamp Monotonicity', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('upgrades v2 registries without inventing a credential source', () => {
    const { registry, migrated } = migrateRegistry(schema2Registry());

    expect(migrated).toBe(true);
    expect(registry.schemaVersion).toBe(3);
    expect(registry.activeAccountId).toBe('acc_native');
    expect(registry.settings.defaultLocation).toBe('global');

    // Where the credentials came from is unrecoverable for pre-existing
    // accounts, so it is recorded as unknown rather than assumed.
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

  it('rejects schema versions it never wrote, naming the ones it reads', () => {
    // Schema 1 predates this project; nothing here has ever written one.
    expect(() => migrateRegistry({ schemaVersion: 1, accounts: [] })).toThrow(
      /Unsupported registry schema version 1; agy-auth reads 2 and 3/
    );

    // A newer registry means the installed agy-auth is the old one.
    expect(() => migrateRegistry({ schemaVersion: 4, accounts: [] })).toThrow(
      /Unsupported registry schema version 4/
    );

    // An absent or non-numeric version is named rather than assumed to be 1.
    expect(() => migrateRegistry({ accounts: [] })).toThrow(
      /Unsupported registry schema version missing/
    );
    expect(() => migrateRegistry({ schemaVersion: '3', accounts: [] })).toThrow(
      /Unsupported registry schema version "3"/
    );
    expect(() => migrateRegistry(null)).toThrow(/must be an object/);
  });

  it('rejects a malformed v2 registry whole instead of migrating the valid part', () => {
    const partlyValid = schema2Registry();
    // A second account with an unparseable auth type must not be dropped while
    // the first one is migrated: half a registry is worse than a clear refusal.
    partlyValid.accounts[1] = {
      ...partlyValid.accounts[1],
      authType: 'oidc-token',
    } as (typeof partlyValid.accounts)[number];

    expect(() => migrateRegistry(partlyValid)).toThrow();

    const missingAccounts = { schemaVersion: 2, activeAccountId: null, previousAccountId: null };
    expect(() => migrateRegistry(missingAccounts)).toThrow(/accounts: required/);
  });

  it('refuses malformed v2 values instead of substituting defaults', () => {
    // Schema 2 was strict about its settings, so a value it could not have
    // written means the file was edited by something else. Falling back to the
    // defaults would hide that and then save the result.
    const badSettings = { ...schema2Registry(), settings: { defaultLocation: 42 } };
    expect(() => migrateRegistry(badSettings)).toThrow(
      /not a valid schema 2 document \(settings\.defaultLocation/
    );

    const unknownKey = { ...schema2Registry(), lastSwitchedAt: 1 };
    expect(() => migrateRegistry(unknownKey)).toThrow(/not a valid schema 2 document/);
  });

  it('refuses a v2 registry whose active account is missing, leaving the file alone', () => {
    const dangling = JSON.stringify({ ...schema2Registry(), activeAccountId: 'acc_gone' });
    fs.writeFileSync(Paths.registryFile, dangling);

    // Nulling the pointer would deactivate whatever was last in use and write
    // that over the file it was read from.
    expect(() => new RegistryManager()).toThrow(/acc_gone/);
    expect(fs.readFileSync(Paths.registryFile, 'utf-8')).toBe(dangling);
  });

  it('leaves a rejected registry on disk exactly as it was found', () => {
    const v1OnDisk = { schemaVersion: 1, accounts: [] };
    fs.writeFileSync(Paths.registryFile, JSON.stringify(v1OnDisk));

    expect(() => new RegistryManager()).toThrow(/Unsupported registry schema version 1/);

    const rawAfter = JSON.parse(fs.readFileSync(Paths.registryFile, 'utf-8'));
    expect(rawAfter).toEqual(v1OnDisk);
  });

  it('rejects export formats it never wrote and keeps reading format 2', () => {
    // Format 1 (`agy-auth-profile-export`) predates this project.
    expect(() =>
      migrateExportDocument({
        kind: 'agy-auth-profile-export',
        formatVersion: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        includesSecrets: true,
        accounts: [],
      })
    ).toThrow(/Unsupported export document .*agy-auth reads formats 2 and 3/);

    expect(() => migrateExportDocument(null)).toThrow(/root must be an object/);
    expect(() => migrateExportDocument({ kind: 'unknown-export', formatVersion: 99 })).toThrow(
      /Unsupported export document/
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
    const before = JSON.stringify(v2Export);

    const migrated = migrateExportDocument(v2Export);

    expect(migrated.formatVersion).toBe(3);
    expect(migrated.registrySchemaVersion).toBe(3);
    expect(migrated.exportedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(migrated.accounts[0].credentialSource).toBe('unknown');

    // The document handed in is never edited in place.
    expect(JSON.stringify(v2Export)).toBe(before);
  });

  it('rejects a malformed v2 export document rather than importing part of it', () => {
    expect(() =>
      migrateExportDocument({
        kind: 'agy-auth-export',
        formatVersion: 2,
        registrySchemaVersion: 2,
        exportedAt: '2026-01-01T00:00:00.000Z',
        includesSecrets: false,
        accounts: [{ id: 'acc_broken', email: 'not-an-email', authType: 'api-key' }],
      })
    ).toThrow();
  });

  it('aborts migration and leaves original registry untouched if backup creation fails', () => {
    const v2Data = schema2Registry();
    fs.writeFileSync(Paths.registryFile, JSON.stringify(v2Data));

    // Mock Storage.createBackup to return null (failure)
    const backupSpy = vi.spyOn(Storage, 'createBackup').mockReturnValue(null);

    try {
      expect(() => new RegistryManager()).toThrow(/Could not create a migration backup/);

      // Verify original file on disk is still raw v2
      const rawAfter = JSON.parse(fs.readFileSync(Paths.registryFile, 'utf-8'));
      expect(rawAfter.schemaVersion).toBe(2);
      expect(rawAfter.accounts[0].credentialSource).toBeUndefined();
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

  it('clears stale verification when replacement credentials reset an account', () => {
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
