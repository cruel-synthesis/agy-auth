import { describeSchemaFailure } from './errors.js';
import {
  Account,
  CURRENT_SCHEMA_VERSION,
  ExportDocumentV2Schema,
  ExportDocumentV3,
  ExportDocumentV3Schema,
  Registry,
  RegistrySchema,
  RegistryV2Schema,
  isRecord,
} from './types.js';

/**
 * Registry schema versions this build can read.
 *
 * Schema 2 shipped from the first release until credential provenance was
 * recorded, so registries and backups written then are still migrated on open.
 * Schema 1 was never written by agy-auth: a file claiming it is rejected rather
 * than guessed at.
 */
const READABLE_SCHEMA_VERSIONS: readonly number[] = [2, CURRENT_SCHEMA_VERSION];

function describeVersion(raw: unknown): string {
  return raw === undefined ? 'missing' : JSON.stringify(raw);
}

export function validateUniqueness(accounts: Account[]): void {
  const ids = new Set<string>();
  const aliases = new Map<string, string>();
  const identities = new Map<string, string>();

  for (const acc of accounts) {
    if (ids.has(acc.id)) {
      throw new Error(`Duplicate account ID '${acc.id}'.`);
    }
    ids.add(acc.id);

    if (acc.alias) {
      const aliasKey = acc.alias.toLowerCase();
      const existing = aliases.get(aliasKey);
      if (existing) {
        throw new Error(
          `Duplicate alias '${acc.alias}' on accounts '${existing}' and '${acc.id}'.`
        );
      }
      aliases.set(aliasKey, acc.id);
    }

    const identityKey = `${acc.email.toLowerCase()}\u0000${acc.authType}`;
    const existingId = identities.get(identityKey);
    if (existingId) {
      throw new Error(
        `Duplicate identity '${acc.email}' (${acc.authType}) on accounts '${existingId}' and '${acc.id}'.`
      );
    }
    identities.set(identityKey, acc.id);
  }
}

/**
 * Records where an OAuth account's credentials came from.
 *
 * Schema 2 carries no such record and it cannot be reconstructed, so it is
 * marked `unknown` rather than assumed to be native.
 */
function upgradeAccountProvenance(account: Account): Account {
  if (account.authType !== 'oauth' || account.credentialSource !== undefined) {
    return account;
  }
  return { ...account, credentialSource: 'unknown' };
}

export function migrateRegistry(raw: unknown): { registry: Registry; migrated: boolean } {
  if (!isRecord(raw)) {
    throw new Error('Registry data must be an object.');
  }

  const rawVersion = raw.schemaVersion;
  if (typeof rawVersion !== 'number' || !READABLE_SCHEMA_VERSIONS.includes(rawVersion)) {
    throw new Error(
      `Unsupported registry schema version ${describeVersion(rawVersion)}; agy-auth reads ${READABLE_SCHEMA_VERSIONS.join(' and ')}. The registry was left unchanged.`
    );
  }

  if (rawVersion === CURRENT_SCHEMA_VERSION) {
    const parsed = RegistrySchema.parse(raw);
    validateUniqueness(parsed.accounts);
    return { registry: parsed, migrated: false };
  }

  // Schema 2 is the current schema without credential provenance, so the whole
  // document is checked against it before any of it is converted: a file that
  // is only partly valid is refused rather than repaired into a shape it was
  // never written in. Account pointers and settings then carry over exactly as
  // they were found; whether a pointer still names an account is a registry
  // invariant, and the caller checks migrated and current registries alike.
  const parsed = RegistryV2Schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Registry is not a valid schema 2 document (${describeSchemaFailure(parsed.error)}). The registry was left unchanged.`
    );
  }

  const accounts = parsed.data.accounts.map(upgradeAccountProvenance);
  validateUniqueness(accounts);

  const migratedRegistry: Registry = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeAccountId: parsed.data.activeAccountId,
    previousAccountId: parsed.data.previousAccountId,
    accounts,
    settings: parsed.data.settings,
  };

  return { registry: migratedRegistry, migrated: true };
}

/**
 * Reads an export document, upgrading format 2 to the current shape.
 *
 * The document on disk is never written back: the caller receives a converted
 * copy and the original file is left exactly as it was found.
 */
export function migrateExportDocument(raw: unknown): ExportDocumentV3 {
  if (!isRecord(raw)) {
    throw new Error('Invalid export document: root must be an object.');
  }

  if (raw.kind === 'agy-auth-export' && raw.formatVersion === 3) {
    const parsed = ExportDocumentV3Schema.parse(raw);
    validateUniqueness(parsed.accounts);
    return parsed;
  }

  // Format 2 predates credential provenance and is otherwise already v3-shaped.
  if (raw.kind === 'agy-auth-export' && raw.formatVersion === 2) {
    const parsed = ExportDocumentV2Schema.parse(raw);
    const accounts = parsed.accounts.map(upgradeAccountProvenance);
    validateUniqueness(accounts);
    return {
      kind: 'agy-auth-export',
      formatVersion: 3,
      registrySchemaVersion: 3,
      exportedAt: parsed.exportedAt,
      includesSecrets: parsed.includesSecrets,
      accounts,
    };
  }

  throw new Error(
    `Unsupported export document (kind=${describeVersion(raw.kind)}, formatVersion=${describeVersion(raw.formatVersion)}); agy-auth reads formats 2 and 3.`
  );
}
