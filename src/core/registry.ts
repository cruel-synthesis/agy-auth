import crypto from 'node:crypto';
import fs from 'node:fs';
import { validateAccountCredentials } from './credential-validation.js';
import { migrateRegistry, validateUniqueness } from './migration.js';
import { Paths } from './paths.js';
import { CorruptedRegistryError, ManagedBackupPrefix, Storage } from './storage.js';
import {
  Account,
  AccountSchema,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  Registry,
  RegistrySchema,
} from './types.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextTimestamp(previous = 0): number {
  return Math.max(Date.now(), previous + 1);
}

interface MutationOptions {
  backupPrefix?: ManagedBackupPrefix;
}

function emptyRegistry(): Registry {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeAccountId: null,
    previousAccountId: null,
    accounts: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Validate both the shape and the cross-record relationships of a registry. */
export function validateRegistry(registry: Registry): void {
  RegistrySchema.parse(registry);
  validateUniqueness(registry.accounts);

  for (const account of registry.accounts) {
    const credVal = validateAccountCredentials(account);
    if (!credVal.ok) {
      throw new Error(
        `Registry invariant violated: account '${account.email}' (${account.id}) has invalid credentials: ${credVal.reason}`
      );
    }
  }

  const ids = new Set(registry.accounts.map((account) => account.id));
  if (registry.activeAccountId !== null && !ids.has(registry.activeAccountId)) {
    throw new Error(
      `Registry invariant violated: active account '${registry.activeAccountId}' does not exist.`
    );
  }
  if (registry.previousAccountId !== null && !ids.has(registry.previousAccountId)) {
    throw new Error(
      `Registry invariant violated: previous account '${registry.previousAccountId}' does not exist.`
    );
  }
  if (
    registry.activeAccountId !== null &&
    registry.previousAccountId !== null &&
    registry.activeAccountId === registry.previousAccountId
  ) {
    throw new Error('Registry invariant violated: active and previous accounts must differ.');
  }
}

export class RegistryManager {
  private data: Registry;

  constructor() {
    this.data = this.load(false);
  }

  /**
   * Reload registry from disk
   */
  public reload(): void {
    this.data = this.load(false);
  }

  /**
   * Load registry from disk with strict corruption protection and migration under lock.
   */
  private load(isLocked: boolean): Registry {
    Paths.ensureDirectories();
    const registryFile = Paths.registryFile;

    if (!isLocked) {
      return Storage.withLockSync(Paths.registryLockFile, () => this.load(true));
    }

    if (!fs.existsSync(registryFile)) {
      return emptyRegistry();
    }

    const registryStat = fs.lstatSync(registryFile);
    if (registryStat.isSymbolicLink() || !registryStat.isFile()) {
      throw new CorruptedRegistryError(
        registryFile,
        null,
        new Error('Registry path must be a regular file and must not be a symbolic link.')
      );
    }

    let registryFd: number | null = null;
    let raw: string;
    try {
      const flags =
        fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
      registryFd = fs.openSync(registryFile, flags);
      const openedStat = fs.fstatSync(registryFd);
      if (
        !openedStat.isFile() ||
        openedStat.dev !== registryStat.dev ||
        openedStat.ino !== registryStat.ino
      ) {
        throw new Error('Registry file changed while it was being opened.');
      }
      raw = fs.readFileSync(registryFd, 'utf-8');
    } catch (err: unknown) {
      const cause =
        err && typeof err === 'object' && 'code' in err && err.code === 'ELOOP'
          ? new Error('Registry path must be a regular file and must not be a symbolic link.')
          : err;
      throw new CorruptedRegistryError(registryFile, null, cause);
    } finally {
      if (registryFd !== null) {
        fs.closeSync(registryFd);
      }
    }
    if (!raw.trim()) {
      const backupPath = Storage.createBackup(registryFile, 'corrupt_registry_emergency');
      throw new CorruptedRegistryError(
        registryFile,
        backupPath,
        new Error('Registry file is empty.')
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const backupPath = Storage.createBackup(registryFile, 'corrupt_registry_emergency');
      throw new CorruptedRegistryError(registryFile, backupPath, err);
    }

    try {
      const { registry: migrated, migrated: wasMigrated } = migrateRegistry(parsed);
      validateRegistry(migrated);
      if (wasMigrated) {
        // Validation above has already passed, so nothing is backed up or
        // rewritten unless the upgraded registry is known to be complete.
        const backupPath = Storage.createBackup(registryFile, 'schema_migration');
        if (!backupPath) {
          throw new Error(
            'Could not create a migration backup; aborting migration with registry untouched.'
          );
        }
        Storage.writeJson(registryFile, migrated);
      }
      return migrated;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Unsupported registry schema version')) {
        throw err;
      }
      if (err instanceof Error && err.message.includes('Could not create a migration backup')) {
        throw err;
      }
      const backupPath = Storage.createBackup(registryFile, 'corrupt_registry_emergency');
      throw new CorruptedRegistryError(registryFile, backupPath, err);
    }
  }

  /**
   * Persist registry to disk with schema validation
   */
  private save(registry: Registry = this.data): void {
    Paths.ensureDirectories();
    validateRegistry(registry);
    Storage.writeJson(Paths.registryFile, registry);
  }

  /**
   * Execute an atomic, locked transaction on the registry across processes.
   */
  public async mutate<T>(
    fn: (draft: Registry) => T | Promise<T>,
    options: MutationOptions = {}
  ): Promise<T> {
    return Storage.withLock(Paths.registryLockFile, async () => {
      const draft = this.load(true);
      if (options.backupPrefix && fs.existsSync(Paths.registryFile)) {
        const backupPath = Storage.createBackup(Paths.registryFile, options.backupPrefix);
        if (!backupPath) {
          throw new Error('Could not create a registry backup; mutation aborted.');
        }
      }
      const result = await fn(draft);
      this.save(draft);
      this.data = draft;
      return result;
    });
  }

  /**
   * Synchronous mutation protected by file lock (for synchronous CLI methods)
   */
  public syncMutate<T>(fn: (draft: Registry) => T, options: MutationOptions = {}): T {
    return Storage.withLockSync(Paths.registryLockFile, () => {
      const draft = this.load(true);
      if (options.backupPrefix && fs.existsSync(Paths.registryFile)) {
        const backupPath = Storage.createBackup(Paths.registryFile, options.backupPrefix);
        if (!backupPath) {
          throw new Error('Could not create a registry backup; mutation aborted.');
        }
      }
      const result = fn(draft);
      this.save(draft);
      this.data = draft;
      return result;
    });
  }

  /**
   * Get raw registry data (cloned to prevent state leakage)
   */
  public getRegistry(): Registry {
    this.reload();
    return clone(this.data);
  }

  /**
   * Get list of all registered accounts (cloned)
   */
  public getAccounts(): Account[] {
    this.reload();
    return clone(this.data.accounts);
  }

  /**
   * Get currently active account (cloned)
   */
  public getActiveAccount(): Account | null {
    this.reload();
    if (!this.data.activeAccountId) return null;
    const acc = this.data.accounts.find((a) => a.id === this.data.activeAccountId);
    return acc ? clone(acc) : null;
  }

  /**
   * Get previously active account (cloned)
   */
  public getPreviousAccount(): Account | null {
    this.reload();
    if (!this.data.previousAccountId) return null;
    const acc = this.data.accounts.find((a) => a.id === this.data.previousAccountId);
    return acc ? clone(acc) : null;
  }

  /**
   * Add or update an account in the registry (fully locked & validated).
   * Active pointer is NEVER modified here.
   */
  public addOrUpdateAccount(
    accountData: Partial<Account> & { email: string; authType: Account['authType'] }
  ): Account {
    if (accountData.id && !/^[a-zA-Z0-9_-]+$/.test(accountData.id)) {
      throw new Error(
        `Invalid account ID '${accountData.id}'. Must be alphanumeric with dashes or underscores.`
      );
    }

    return this.syncMutate((draft) => {
      const email = accountData.email.trim();
      const identityKey = `${email.toLowerCase()}\u0000${accountData.authType}`;

      const existingIndex = draft.accounts.findIndex(
        (a) =>
          (accountData.id && a.id === accountData.id) ||
          `${a.email.trim().toLowerCase()}\u0000${a.authType}` === identityKey
      );

      if (existingIndex >= 0) {
        const existing = draft.accounts[existingIndex];
        const updated: Account = {
          ...existing,
          ...accountData,
          id: existing.id,
          email,
          alias:
            accountData.alias !== undefined
              ? accountData.alias.trim() || undefined
              : existing.alias,
          verification:
            accountData.verification !== undefined
              ? accountData.verification
              : existing.verification,
          credentials: accountData.credentials || existing.credentials,
          createdAt: existing.createdAt,
          updatedAt: nextTimestamp(existing.updatedAt),
        };
        if (accountData.status === 'unverified' && accountData.verification === undefined) {
          delete updated.verification;
        }
        const parsed = AccountSchema.parse(updated);
        draft.accounts[existingIndex] = parsed;
        return clone(parsed);
      }

      const id = accountData.id || `acc_${crypto.randomBytes(4).toString('hex')}`;
      const now = Date.now();
      const newAccount: Account = {
        id,
        email,
        alias: accountData.alias?.trim() || undefined,
        authType: accountData.authType,
        credentials: accountData.credentials,
        credentialSource: accountData.credentialSource,
        oauthClientId: accountData.oauthClientId,
        status: accountData.status || 'unverified',
        verification: accountData.verification,
        gcpProject: accountData.gcpProject,
        gcpLocation: accountData.gcpLocation,
        model: accountData.model,
        reasoningEffort: accountData.reasoningEffort,
        plan: accountData.plan,
        rateLimit: accountData.rateLimit,
        quotaCheckedAt: accountData.quotaCheckedAt,
        createdAt: now,
        updatedAt: now,
      };
      const parsed = AccountSchema.parse(newAccount);
      draft.accounts.push(parsed);

      return clone(parsed);
    });
  }

  /**
   * Set the active account ID with history tracking and optimistic concurrency verification.
   */
  public setActiveAccount(id: string, expectedUpdatedAt?: number): Account | null {
    return this.syncMutate((draft) => {
      const acc = draft.accounts.find((a) => a.id === id);
      if (!acc) return null;
      if (expectedUpdatedAt !== undefined && acc.updatedAt !== expectedUpdatedAt) {
        return null;
      }

      if (draft.activeAccountId === id) return clone(acc);

      const previous = draft.activeAccountId;
      draft.activeAccountId = id;
      draft.previousAccountId = previous;

      acc.lastUsedAt = Date.now();
      acc.updatedAt = nextTimestamp(acc.updatedAt);
      return clone(acc);
    });
  }

  /**
   * Set or clear an account alias
   */
  public setAlias(id: string, alias: string | null): void {
    this.syncMutate((draft) => {
      const acc = draft.accounts.find((a) => a.id === id);
      if (!acc) throw new Error(`Account '${id}' not found.`);

      if (alias !== null) {
        const trimmed = alias.trim();
        const existing = draft.accounts.find(
          (a) => a.id !== id && a.alias?.toLowerCase() === trimmed.toLowerCase()
        );
        if (existing) {
          throw new Error(`Alias '${trimmed}' is already in use by ${existing.email}.`);
        }
        acc.alias = trimmed;
      } else {
        delete acc.alias;
      }

      acc.updatedAt = nextTimestamp(acc.updatedAt);
    });
  }

  /**
   * Set GCP project for an account
   */
  public setProject(id: string, project: string | null, location?: string | null): void {
    this.syncMutate((draft) => {
      const acc = draft.accounts.find((a) => a.id === id);
      if (!acc) throw new Error(`Account '${id}' not found.`);

      acc.gcpProject = project ? project.trim() : undefined;
      if (location !== undefined) {
        acc.gcpLocation = location ? location.trim() : undefined;
      }
      acc.updatedAt = nextTimestamp(acc.updatedAt);
    });
  }

  /**
   * Set model preferences for an account
   */
  public setModel(id: string, model: string | null, reasoningEffort?: string | null): void {
    this.syncMutate((draft) => {
      const acc = draft.accounts.find((a) => a.id === id);
      if (!acc) throw new Error(`Account '${id}' not found.`);

      acc.model = model ? model.trim() : undefined;
      if (reasoningEffort !== undefined) {
        acc.reasoningEffort = reasoningEffort ? reasoningEffort.trim() : undefined;
      }
      acc.updatedAt = nextTimestamp(acc.updatedAt);
    });
  }

  /**
   * Find an account matching a selector query.
   */
  public findAccount(query: string): Account | null {
    const results = this.findAccounts(query);
    return results.length === 1 ? results[0] : null;
  }

  /**
   * Find all accounts matching a selector query with disambiguation ordering.
   */
  public findAccounts(query: string): Account[] {
    this.reload();
    const trimmed = query.trim();
    if (!trimmed) return [];

    const lower = trimmed.toLowerCase();

    // 1. Check numeric 1-based row index (e.g. "1", "01", "2")
    const parsedIndex = parseInt(trimmed, 10);
    if (
      !Number.isNaN(parsedIndex) &&
      String(parsedIndex) === trimmed.replace(/^0+/, '') &&
      parsedIndex >= 1 &&
      parsedIndex <= this.data.accounts.length
    ) {
      return [clone(this.data.accounts[parsedIndex - 1])];
    }

    // 2. Exact match on alias
    const exactAlias = this.data.accounts.filter((a) => a.alias?.toLowerCase() === lower);
    if (exactAlias.length > 0) return clone(exactAlias);

    // 3. Exact match on email
    const exactEmail = this.data.accounts.filter((a) => a.email.toLowerCase() === lower);
    if (exactEmail.length > 0) return clone(exactEmail);

    // 4. Exact match on ID
    const exactId = this.data.accounts.filter((a) => a.id === trimmed);
    if (exactId.length > 0) return clone(exactId);

    // 5. Prefix match on ID (min 4 chars)
    if (trimmed.length >= 4) {
      const prefixId = this.data.accounts.filter((a) => a.id.startsWith(trimmed));
      if (prefixId.length > 0) return clone(prefixId);
    }

    // 6. Substring match on email or alias
    const substringMatches = this.data.accounts.filter(
      (a) => a.email.toLowerCase().includes(lower) || a.alias?.toLowerCase().includes(lower)
    );

    return clone(substringMatches);
  }
}
