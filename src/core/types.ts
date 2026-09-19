import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 3;

export const AuthTypeSchema = z.enum(['oauth', 'api-key', 'service-account', 'adc']);
export type AuthType = z.infer<typeof AuthTypeSchema>;

export const AccountStatusSchema = z.enum([
  'valid',
  'rate-limited',
  'invalid',
  'expired',
  'needs-reauth',
  'unverified',
  'unknown',
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/**
 * A single usage window reported by the Antigravity quota contracts.
 * `usedPercent` is a percentage (0-100), not a fraction, and `resetsAt` is an
 * epoch-second instant after which the cached window is stale rather than valid.
 */
export const RateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite().min(0).max(100),
    windowMinutes: z.number().int().positive().finite().max(525_600),
    resetsAt: z.number().int().positive().finite().optional(),
  })
  .strict();
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

export const ModelRateLimitsSchema = z
  .object({
    rate5h: RateLimitWindowSchema.optional(),
    rateWeekly: RateLimitWindowSchema.optional(),
  })
  .strict();
export type ModelRateLimits = z.infer<typeof ModelRateLimitsSchema>;

/** Only the model families and windows agy-auth can name are represented. */
export const RateLimitSnapshotSchema = z
  .object({
    gemini: ModelRateLimitsSchema.optional(),
    claude: ModelRateLimitsSchema.optional(),
  })
  .strict();
export type RateLimitSnapshot = z.infer<typeof RateLimitSnapshotSchema>;

export const WINDOW_MINUTES_5H = 300;
export const WINDOW_MINUTES_WEEKLY = 10_080;

export const VerificationRecordSchema = z
  .object({
    checkedAt: z.number().int().nonnegative().finite(),
    source: z.string().max(256),
    message: z.string().max(1024).optional(),
  })
  .strict();
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

export const ServiceAccountKeySchema = z
  .object({
    type: z.literal('service_account'),
    project_id: z.string().max(128),
    private_key_id: z.string().max(128).optional(),
    private_key: z.string(),
    client_email: z.string().email().max(256),
    client_id: z.string().max(128).optional(),
    auth_uri: z.string().max(512).optional(),
    token_uri: z.string().max(512).optional(),
    auth_provider_x509_cert_url: z.string().max(512).optional(),
    client_x509_cert_url: z.string().max(512).optional(),
    universe_domain: z.string().max(253).optional(),
  })
  .strict();
export type ServiceAccountKey = z.infer<typeof ServiceAccountKeySchema>;

/**
 * The Antigravity session payload, which agy-auth reads and writes but does not
 * own.
 *
 * The installed client stores fields beyond the ones modelled here -- an
 * `id_token` today, and whatever a later release adds. Rejecting those makes a
 * real session unreadable, and dropping them on write hands the official client
 * back a session it no longer recognises, so unknown keys are carried through
 * untouched. Registry-owned schemas stay strict.
 */
export const KeychainPayloadSchema = z
  .object({
    auth_method: z.string().max(64).default('consumer'),
    token: z
      .object({
        access_token: z.string().refine((value) => value.trim().length > 0, {
          message: 'access_token must not be empty or whitespace',
        }),
        refresh_token: z.string().optional().default(''),
        token_type: z.string().max(64).optional(),
        expiry: z.string().max(128).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type KeychainPayload = z.infer<typeof KeychainPayloadSchema>;

export const AccountCredentialsSchema = z
  .object({
    keychainPayload: KeychainPayloadSchema.optional(),
    apiKey: z.string().max(1024).optional(),
    serviceAccountKey: ServiceAccountKeySchema.optional(),
    adcPath: z.string().max(1024).optional(),
  })
  .strict();
export type AccountCredentials = z.infer<typeof AccountCredentialsSchema>;

/**
 * Which OAuth client issued an account's credentials.
 *
 * A refresh token is only usable by the client it was issued to, so this
 * decides whether agy-auth may attempt a refresh at all. `unknown` covers
 * profiles saved before this was recorded: their origin cannot be recovered, so
 * it is never guessed.
 */
export const OAuthCredentialSourceSchema = z.enum(['antigravity', 'custom-client', 'unknown']);

export const AccountSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(64),
    email: z.string().email().max(256),
    alias: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/)
      .optional(),
    authType: AuthTypeSchema,
    credentials: AccountCredentialsSchema.optional(),
    /** OAuth profiles only: which client issued these credentials. */
    credentialSource: OAuthCredentialSourceSchema.optional(),
    /** The custom OAuth client id that issued them, when one did. */
    oauthClientId: z.string().max(256).optional(),
    status: AccountStatusSchema.default('unverified'),
    verification: VerificationRecordSchema.optional(),
    gcpProject: z.string().max(128).optional(),
    gcpLocation: z.string().max(64).optional(),
    model: z.string().max(128).optional(),
    reasoningEffort: z.string().max(64).optional(),
    plan: z.string().max(128).optional(),
    rateLimit: RateLimitSnapshotSchema.optional(),
    quotaCheckedAt: z.number().int().nonnegative().finite().optional(),
    createdAt: z.number().int().nonnegative().finite(),
    updatedAt: z.number().int().nonnegative().finite(),
    lastUsedAt: z.number().int().nonnegative().finite().optional(),
  })
  .strict();
export type Account = z.infer<typeof AccountSchema>;

/** Statuses that cannot improve until the user signs in again. */
const NEEDS_SIGN_IN: ReadonlySet<AccountStatus> = new Set(['expired', 'invalid', 'needs-reauth']);

/** True when the account cannot serve work until the user signs in again. */
export function needsSignIn(account: Account): boolean {
  return NEEDS_SIGN_IN.has(account.status);
}

export const RegistrySettingsSchema = z
  .object({
    defaultLocation: z.string().max(64).optional(),
    defaultModel: z.string().max(128).optional(),
  })
  .strict();
export type RegistrySettings = z.infer<typeof RegistrySettingsSchema>;

export const DEFAULT_SETTINGS: RegistrySettings = {
  defaultLocation: 'global',
};

export const RegistrySchema = z
  .object({
    schemaVersion: z.literal(3),
    activeAccountId: z.string().max(64).nullable(),
    previousAccountId: z.string().max(64).nullable(),
    accounts: z.array(AccountSchema),
    settings: RegistrySettingsSchema,
  })
  .strict();
export type Registry = z.infer<typeof RegistrySchema>;

/** Accounts as written before credential provenance was recorded. */
export const AccountV2Schema = AccountSchema.omit({
  credentialSource: true,
  oauthClientId: true,
}).strict();

export const ExportDocumentV2Schema = z
  .object({
    kind: z.literal('agy-auth-export'),
    formatVersion: z.literal(2),
    registrySchemaVersion: z.literal(2),
    exportedAt: z.string().max(128),
    includesSecrets: z.boolean(),
    accounts: z.array(AccountV2Schema),
  })
  .strict();

export const ExportDocumentV3Schema = z
  .object({
    kind: z.literal('agy-auth-export'),
    formatVersion: z.literal(3),
    registrySchemaVersion: z.literal(3),
    exportedAt: z.string().max(128),
    includesSecrets: z.boolean(),
    accounts: z.array(AccountSchema),
  })
  .strict();
export type ExportDocumentV3 = z.infer<typeof ExportDocumentV3Schema>;

export interface SwitchResult {
  previousAccount: Account | null;
  currentAccount: Account;
  antigravityUpdated: boolean;
  adcUpdated: boolean;
  requiresShellUpdate: boolean;
  managedEnvVars: string[];
  warnings?: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeAccount(account: Account): Account {
  const cloned = JSON.parse(JSON.stringify(account)) as Account;
  if (cloned.credentials) {
    delete cloned.credentials.apiKey;
    delete cloned.credentials.serviceAccountKey;
    delete cloned.credentials.keychainPayload;
    delete cloned.credentials.adcPath;
    if (Object.keys(cloned.credentials).length === 0) {
      delete cloned.credentials;
    }
  }
  return cloned;
}

export function sanitizeAccounts(accounts: Account[]): Account[] {
  return accounts.map(sanitizeAccount);
}
