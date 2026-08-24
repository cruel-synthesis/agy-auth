import {
  Account,
  AccountCredentials,
  AccountSchema,
  AccountStatus,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  ExportDocumentV2,
  ExportDocumentV2Schema,
  KeychainPayload,
  ModelRateLimits,
  RateLimitSnapshot,
  RateLimitWindowSchema,
  Registry,
  RegistrySchema,
  WINDOW_MINUTES_5H,
  WINDOW_MINUTES_WEEKLY,
  isRecord,
} from './types.js';

interface LegacyCredentials {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  keychainPayload?: KeychainPayload;
  apiKey?: string;
  serviceAccountKey?: AccountCredentials['serviceAccountKey'];
  adcPath?: string;
}

const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function migrateStatus(rawStatus: unknown, credentials?: AccountCredentials): AccountStatus {
  if (rawStatus === 'needs-reauth') {
    // A token already past its expiry is expired, which is the more specific
    // diagnosis; otherwise the recorded reauth requirement is preserved.
    const payload = credentials?.keychainPayload;
    if (payload?.token?.expiry) {
      const expiryMs = Date.parse(payload.token.expiry);
      if (Number.isFinite(expiryMs) && Date.now() > expiryMs) {
        return 'expired';
      }
    }
    return 'needs-reauth';
  }

  const validStatuses: AccountStatus[] = [
    'valid',
    'rate-limited',
    'invalid',
    'expired',
    'needs-reauth',
    'unverified',
    'unknown',
  ];

  if (typeof rawStatus === 'string' && (validStatuses as string[]).includes(rawStatus)) {
    return rawStatus as AccountStatus;
  }

  return 'unverified';
}

/**
 * Preserve historical quota cache when it still satisfies the strict schema.
 * Malformed windows are dropped rather than repaired: a live refresh repopulates
 * them, and inventing values would present fiction as measurement.
 */
function migrateRateLimit(raw: unknown): RateLimitSnapshot | undefined {
  if (!isRecord(raw)) return undefined;

  const snapshot: RateLimitSnapshot = {};
  for (const family of ['gemini', 'claude'] as const) {
    const rawFamily = raw[family];
    if (!isRecord(rawFamily)) continue;

    const windows: ModelRateLimits = {};
    for (const [key, minutes] of [
      ['rate5h', WINDOW_MINUTES_5H],
      ['rateWeekly', WINDOW_MINUTES_WEEKLY],
    ] as const) {
      const rawWindow = rawFamily[key];
      if (!isRecord(rawWindow)) continue;
      const parsed = RateLimitWindowSchema.safeParse({
        usedPercent: rawWindow.usedPercent,
        windowMinutes:
          typeof rawWindow.windowMinutes === 'number' ? rawWindow.windowMinutes : minutes,
        ...(rawWindow.resetsAt !== undefined ? { resetsAt: rawWindow.resetsAt } : {}),
      });
      if (parsed.success) {
        windows[key] = parsed.data;
      }
    }

    if (windows.rate5h || windows.rateWeekly) {
      snapshot[family] = windows;
    }
  }

  return snapshot.gemini || snapshot.claude ? snapshot : undefined;
}

function migrateTimestamp(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

export function migrateLegacyAccount(raw: unknown, index = 0): Account {
  if (!isRecord(raw)) {
    throw new Error(`Account at index ${index} must be an object.`);
  }

  const id = typeof raw.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(raw.id) ? raw.id : undefined;
  if (!id) {
    throw new Error(`Account at index ${index} has invalid or missing ID.`);
  }

  let email: string | undefined;
  let alias: string | undefined =
    typeof raw.alias === 'string' && raw.alias.trim() ? raw.alias.trim() : undefined;

  if (alias && !ALIAS_REGEX.test(alias)) {
    throw new Error(`Account at index ${index} has invalid alias '${alias}'.`);
  }

  if (typeof raw.email === 'string') {
    const trimmed = raw.email.trim();
    if (EMAIL_REGEX.test(trimmed)) {
      email = trimmed;
    } else if (ALIAS_REGEX.test(trimmed)) {
      // Legacy label conversion to alias + local invalid email
      if (!alias) {
        alias = trimmed;
      }
      email = `${id}@local.invalid`;
    } else {
      throw new Error(
        `Account at index ${index} has invalid email '${raw.email}' which cannot be converted to a valid alias.`
      );
    }
  } else {
    throw new Error(`Account at index ${index} is missing email.`);
  }

  const allowedAuthTypes = ['oauth', 'api-key', 'service-account', 'adc'] as const;
  if (
    typeof raw.authType !== 'string' ||
    !allowedAuthTypes.includes(raw.authType as (typeof allowedAuthTypes)[number])
  ) {
    throw new Error(
      `Account at index ${index} has missing or unsupported authType '${String(raw.authType)}'.`
    );
  }

  const authType = raw.authType as (typeof allowedAuthTypes)[number];

  const credentials: AccountCredentials = {};
  const rawCreds = isRecord(raw.credentials) ? (raw.credentials as LegacyCredentials) : {};

  if (authType === 'oauth') {
    if (isRecord(rawCreds.keychainPayload) && isRecord(rawCreds.keychainPayload.token)) {
      credentials.keychainPayload = {
        auth_method:
          typeof rawCreds.keychainPayload.auth_method === 'string'
            ? rawCreds.keychainPayload.auth_method
            : 'consumer',
        token: {
          access_token: String(rawCreds.keychainPayload.token.access_token || ''),
          refresh_token: String(rawCreds.keychainPayload.token.refresh_token || ''),
          token_type:
            typeof rawCreds.keychainPayload.token.token_type === 'string'
              ? rawCreds.keychainPayload.token.token_type
              : 'Bearer',
          expiry:
            typeof rawCreds.keychainPayload.token.expiry === 'string'
              ? rawCreds.keychainPayload.token.expiry
              : undefined,
        },
      };
    } else if (rawCreds.accessToken) {
      const expiry =
        typeof rawCreds.tokenExpiry === 'number' && Number.isFinite(rawCreds.tokenExpiry)
          ? new Date(rawCreds.tokenExpiry * 1000).toISOString()
          : undefined;
      credentials.keychainPayload = {
        auth_method: 'consumer',
        token: {
          access_token: String(rawCreds.accessToken),
          refresh_token: String(rawCreds.refreshToken || ''),
          token_type: 'Bearer',
          expiry,
        },
      };
    }
  } else if (authType === 'api-key') {
    if (typeof rawCreds.apiKey === 'string') {
      credentials.apiKey = rawCreds.apiKey;
    }
  } else if (authType === 'service-account') {
    if (isRecord(rawCreds.serviceAccountKey)) {
      credentials.serviceAccountKey =
        rawCreds.serviceAccountKey as AccountCredentials['serviceAccountKey'];
    }
  } else if (authType === 'adc') {
    if (typeof rawCreds.adcPath === 'string') {
      credentials.adcPath = rawCreds.adcPath;
    }
  }

  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? Math.max(0, Math.floor(raw.createdAt))
      : Date.now();
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? Math.max(0, Math.floor(raw.updatedAt))
      : createdAt;
  const lastUsedAt =
    typeof raw.lastUsedAt === 'number' && Number.isFinite(raw.lastUsedAt)
      ? Math.max(0, Math.floor(raw.lastUsedAt))
      : undefined;

  const status = migrateStatus(raw.status, credentials);

  const account: Account = {
    id,
    email,
    alias,
    authType,
    credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
    status,
    gcpProject:
      typeof raw.gcpProject === 'string' && raw.gcpProject.trim()
        ? raw.gcpProject.trim()
        : undefined,
    gcpLocation:
      typeof raw.gcpLocation === 'string' && raw.gcpLocation.trim()
        ? raw.gcpLocation.trim()
        : undefined,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    reasoningEffort:
      typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()
        ? raw.reasoningEffort.trim()
        : undefined,
    plan:
      typeof raw.plan === 'string' && raw.plan.trim() && raw.plan.trim().length <= 128
        ? raw.plan.trim()
        : undefined,
    rateLimit: migrateRateLimit(raw.rateLimit),
    quotaCheckedAt: migrateTimestamp(raw.quotaCheckedAt),
    createdAt,
    updatedAt,
    lastUsedAt,
  };

  AccountSchema.parse(account);
  return account;
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

export function migrateRegistry(raw: unknown): { registry: Registry; migrated: boolean } {
  if (!isRecord(raw)) {
    throw new Error('Registry data must be an object.');
  }

  const rawVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;

  if (rawVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported registry schema version ${rawVersion}. This version of agy-auth supports schema version up to ${CURRENT_SCHEMA_VERSION}.`
    );
  }

  if (rawVersion === CURRENT_SCHEMA_VERSION) {
    const parsed = RegistrySchema.parse(raw);
    validateUniqueness(parsed.accounts);
    return { registry: parsed, migrated: false };
  }

  // Migrate schema 1 -> schema 2
  if (!Array.isArray(raw.accounts)) {
    throw new Error("Registry is missing 'accounts' array.");
  }

  const accounts: Account[] = [];
  for (let i = 0; i < raw.accounts.length; i++) {
    const migratedAcc = migrateLegacyAccount(raw.accounts[i], i);
    accounts.push(migratedAcc);
  }

  validateUniqueness(accounts);

  const accountIds = new Set(accounts.map((a) => a.id));
  const activeAccountId =
    typeof raw.activeAccountId === 'string' && accountIds.has(raw.activeAccountId)
      ? raw.activeAccountId
      : null;
  const previousAccountId =
    typeof raw.previousAccountId === 'string' &&
    accountIds.has(raw.previousAccountId) &&
    raw.previousAccountId !== activeAccountId
      ? raw.previousAccountId
      : null;

  const rawSettings = isRecord(raw.settings) ? raw.settings : {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(typeof rawSettings.defaultLocation === 'string'
      ? { defaultLocation: rawSettings.defaultLocation }
      : {}),
    ...(typeof rawSettings.defaultModel === 'string'
      ? { defaultModel: rawSettings.defaultModel }
      : {}),
  };

  const migratedRegistry: Registry = {
    schemaVersion: 2,
    activeAccountId,
    previousAccountId,
    accounts,
    settings,
  };

  RegistrySchema.parse(migratedRegistry);
  return { registry: migratedRegistry, migrated: true };
}

export function migrateExportDocument(raw: unknown): ExportDocumentV2 {
  if (!isRecord(raw)) {
    throw new Error('Invalid export document: root must be an object.');
  }

  // Format v2 documents
  if (raw.kind === 'agy-auth-export' && raw.formatVersion === 2) {
    const parsed = ExportDocumentV2Schema.parse(raw);
    validateUniqueness(parsed.accounts);
    return parsed;
  }

  // Format v1 documents
  if (raw.kind === 'agy-auth-profile-export' && raw.formatVersion === 1) {
    if (!Array.isArray(raw.accounts)) {
      throw new Error("Export document is missing 'accounts' array.");
    }
    const accounts: Account[] = [];
    for (let i = 0; i < raw.accounts.length; i++) {
      const migrated = migrateLegacyAccount(raw.accounts[i], i);
      accounts.push(migrated);
    }
    validateUniqueness(accounts);
    return {
      kind: 'agy-auth-export',
      formatVersion: 2,
      registrySchemaVersion: 2,
      exportedAt:
        typeof raw.exportedAt === 'string' && raw.exportedAt.trim()
          ? raw.exportedAt
          : new Date().toISOString(),
      includesSecrets: Boolean(raw.includesSecrets),
      accounts,
    };
  }

  throw new Error(
    `Unsupported export document format (kind='${String(raw.kind)}', version=${String(raw.formatVersion)}).`
  );
}
