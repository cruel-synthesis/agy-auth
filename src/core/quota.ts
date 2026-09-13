import { VERSION } from '../version.js';
import {
  OAUTH_TOKEN_ENDPOINT,
  type OAuthClientConfig,
  getOAuthClientConfig,
} from './oauth-config.js';
import {
  Account,
  AccountStatus,
  KeychainPayload,
  ModelRateLimits,
  RateLimitSnapshot,
  RateLimitSnapshotSchema,
  RateLimitWindow,
  WINDOW_MINUTES_5H,
  WINDOW_MINUTES_WEEKLY,
  isRecord,
} from './types.js';

/**
 * Live plan and quota reporting against the Antigravity Cloud Code contracts.
 *
 * EXPERIMENTAL: these are undocumented `v1internal` endpoints observed from the
 * Antigravity client. They can change or disappear without notice; every failure
 * mode here degrades to cached data rather than to a wrong number.
 *
 * Endpoint set and the `loadCodeAssist` project-discovery step were derived from
 * ag-multi-account-switchboard (MIT); see THIRD_PARTY_NOTICES.md. Unlike that
 * reference this client never substitutes a default project ID, never ships an
 * OAuth secret, and treats an unrecognized response shape as a failure.
 */

const USER_AGENT = `agy-auth/${VERSION}`;

const QUOTA_SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
] as const;

const RETRIEVE_USER_QUOTA_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
] as const;

const LOAD_CODE_ASSIST_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
] as const;

const DEFAULT_QUOTA_DEADLINE_MS = 15_000;
const DEFAULT_QUOTA_REQUEST_TIMEOUT_MS = 8_000;
export const QUOTA_REFRESH_CONCURRENCY = 4;
const TOKEN_REFRESH_BUFFER_SECONDS = 300;

export type QuotaFailureReason =
  | 'not-applicable'
  | 'token-expired'
  /** agy-auth holds no client authorised to refresh these credentials. */
  | 'native-refresh-required'
  | 'scope-insufficient'
  | 'auth-failed'
  | 'quota-unavailable'
  | 'network-error';

/**
 * Outcome of one account's quota refresh. Deliberately secret-free: safe to log,
 * serialize into the JSON envelope, or attach to a diagnostic.
 */
export interface QuotaResult {
  accountId: string;
  /** `updatedAt` observed before any network activity, for optimistic concurrency. */
  observedUpdatedAt: number;
  ok: boolean;
  reason?: QuotaFailureReason;
  plan?: string;
  rateLimit?: RateLimitSnapshot;
  /** Epoch milliseconds of the last successful live quota fetch. */
  quotaCheckedAt?: number;
  /** Project discovered via loadCodeAssist when the profile had none configured. */
  discoveredProject?: string;
  /** Set only when the outcome is decisive enough to assert a credential status. */
  status?: AccountStatus;
}

export type RefreshedToken = KeychainPayload['token'];

/**
 * Carrier for a rotated OAuth token, kept out of {@link QuotaResult} so no code
 * path can serialize a credential by accident.
 */
export class TokenUpdate {
  constructor(public readonly token: RefreshedToken) {}

  public toJSON(): string {
    return '[redacted]';
  }

  public toString(): string {
    return '[redacted]';
  }
}

export interface QuotaRefresh {
  result: QuotaResult;
  tokenUpdate?: TokenUpdate;
}

export interface QuotaOptions {
  fetchFn?: typeof fetch;
  /** Current time in epoch milliseconds. */
  now?: () => number;
  /** Total bounded budget for one account across every request it makes. */
  deadlineMs?: number;
  /** Per-request ceiling, further clamped by the remaining total budget. */
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface QuotaRefreshSummary {
  attempted: boolean;
  offline: boolean;
  accounts: { accountId: string; ok: boolean; reason?: QuotaFailureReason }[];
}

type QuotaFamily = 'gemini' | 'claude';
type QuotaWindow = '5h' | 'weekly';

type PostOutcome =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'auth' }
  | { kind: 'scope' }
  | { kind: 'transport' };

interface RequestContext {
  fetchFn: typeof fetch;
  now: () => number;
  endsAt: number;
  requestTimeoutMs: number;
}

interface WindowCandidate {
  family: QuotaFamily;
  window: QuotaWindow;
  usedPercent: number;
  resetsAt?: number;
}

interface CodeAssistInfo {
  outcome: PostOutcome['kind'];
  plan?: string;
  project?: string;
}

function remainingBudget(ctx: RequestContext): number {
  return ctx.endsAt - ctx.now();
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

/** Server fractions are `remaining / total` and must land inside the unit interval. */
function validFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseResetTime(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed / 1000);
}

function classifyWindowValue(value: unknown): QuotaWindow | undefined {
  const text = normalizedText(value);
  if (!text) return undefined;

  if (
    text === '5h' ||
    text === '5-hour' ||
    text === '5 hour' ||
    text === 'five-hour' ||
    text === 'five hour' ||
    /(?:^|[-_:])5h(?:$|[-_:])/.test(text)
  ) {
    return '5h';
  }
  if (
    text === 'weekly' ||
    text === 'week' ||
    text === '7d' ||
    /(?:^|[-_:])weekly(?:$|[-_:])/.test(text)
  ) {
    return 'weekly';
  }
  return undefined;
}

/** Conflicting labels across the fields of one bucket make the window unknowable. */
function classifyWindow(...values: unknown[]): QuotaWindow | undefined {
  let found: QuotaWindow | undefined;
  for (const value of values) {
    const current = classifyWindowValue(value);
    if (!current) continue;
    if (found && found !== current) return undefined;
    found = current;
  }
  return found;
}

/** Only explicit Gemini and Claude/GPT families are accepted; anything else is dropped. */
function classifyFamily(...values: unknown[]): QuotaFamily | undefined {
  const families = new Set<QuotaFamily>();
  for (const value of values) {
    const text = normalizedText(value);
    if (!text) continue;
    if (/(?:^|[^a-z])gemini(?:[^a-z]|$)/.test(text)) families.add('gemini');
    if (/(?:^|[^a-z])(?:claude|gpt|3p)(?:[^a-z]|$)/.test(text)) families.add('claude');
  }
  return families.size === 1 ? [...families][0] : undefined;
}

function containsScopeError(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') {
    const normalized = value.toUpperCase();
    return (
      normalized.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
      normalized.includes('INSUFFICIENT AUTHENTICATION SCOPE')
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsScopeError(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).some((entry) => containsScopeError(entry, depth + 1));
  }
  return false;
}

function usedPercentFromFraction(fraction: number): number {
  const used = Math.round((1 - fraction) * 100);
  return Math.min(100, Math.max(0, used));
}

/**
 * When several buckets describe one family/window pair the most constrained
 * remaining quota wins, with the earliest valid reset time as tie-breaker.
 */
function moreConstrained(a: WindowCandidate, b: WindowCandidate): WindowCandidate {
  if (a.usedPercent !== b.usedPercent) return a.usedPercent > b.usedPercent ? a : b;
  if (a.resetsAt === undefined) return b.resetsAt === undefined ? a : b;
  if (b.resetsAt === undefined) return a;
  return b.resetsAt < a.resetsAt ? b : a;
}

function buildSnapshot(candidates: WindowCandidate[]): RateLimitSnapshot {
  const selected = new Map<string, WindowCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.family}:${candidate.window}`;
    const previous = selected.get(key);
    selected.set(key, previous ? moreConstrained(previous, candidate) : candidate);
  }

  const snapshot: RateLimitSnapshot = {};
  for (const candidate of selected.values()) {
    const window: RateLimitWindow = {
      usedPercent: candidate.usedPercent,
      windowMinutes: candidate.window === '5h' ? WINDOW_MINUTES_5H : WINDOW_MINUTES_WEEKLY,
      ...(candidate.resetsAt !== undefined ? { resetsAt: candidate.resetsAt } : {}),
    };
    if (!snapshot[candidate.family]) {
      snapshot[candidate.family] = {};
    }
    const family = snapshot[candidate.family] as ModelRateLimits;
    if (candidate.window === '5h') {
      family.rate5h = window;
    } else {
      family.rateWeekly = window;
    }
  }

  // A snapshot that cannot round-trip the strict schema is treated as unusable.
  const parsed = RateLimitSnapshotSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : {};
}

function hasUsableWindows(snapshot: RateLimitSnapshot | undefined): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.gemini?.rate5h ||
      snapshot.gemini?.rateWeekly ||
      snapshot.claude?.rate5h ||
      snapshot.claude?.rateWeekly
  );
}

/** Contract A: `retrieveUserQuotaSummary` returns `groups[].buckets[]`. */
export function collectFromSummary(payload: unknown): WindowCandidate[] {
  const candidates: WindowCandidate[] = [];
  if (!isRecord(payload) || !Array.isArray(payload.groups)) return candidates;

  for (const group of payload.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const groupLabels = [group.displayName, group.description];

    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      if (!validFraction(bucket.remainingFraction)) continue;

      const window = classifyWindow(bucket.window, bucket.bucketId, bucket.displayName);
      if (!window) continue;

      const family = classifyFamily(
        ...groupLabels,
        bucket.bucketId,
        bucket.displayName,
        bucket.description
      );
      if (!family) continue;

      candidates.push({
        family,
        window,
        usedPercent: usedPercentFromFraction(bucket.remainingFraction),
        resetsAt: parseResetTime(bucket.resetTime),
      });
    }
  }

  return candidates;
}

/** Contract B: `retrieveUserQuota` returns a flat `buckets[]` keyed by model. */
export function collectFromBuckets(payload: unknown): WindowCandidate[] {
  const candidates: WindowCandidate[] = [];
  const buckets = isRecord(payload) ? payload.buckets : payload;
  if (!Array.isArray(buckets)) return candidates;

  for (const bucket of buckets) {
    if (!isRecord(bucket)) continue;
    const fraction = validFraction(bucket.remainingFraction)
      ? bucket.remainingFraction
      : validFraction(bucket.remaining_fraction)
        ? bucket.remaining_fraction
        : undefined;
    if (fraction === undefined) continue;

    const window = classifyWindow(
      bucket.tokenType,
      bucket.token_type,
      bucket.modelId,
      bucket.model_id
    );
    if (!window) continue;

    const family = classifyFamily(
      bucket.modelId,
      bucket.model_id,
      bucket.tokenType,
      bucket.token_type
    );
    if (!family) continue;

    candidates.push({
      family,
      window,
      usedPercent: usedPercentFromFraction(fraction),
      resetsAt: parseResetTime(bucket.resetTime ?? bucket.reset_time),
    });
  }

  return candidates;
}

export function summarizeQuotaRefresh(
  offline: boolean,
  refreshes: QuotaRefresh[]
): QuotaRefreshSummary {
  return {
    attempted: !offline && refreshes.length > 0,
    offline,
    accounts: refreshes.map(({ result }) => ({
      accountId: result.accountId,
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
    })),
  };
}

export class QuotaClient {
  private static async post(
    url: string,
    body: unknown,
    accessToken: string,
    ctx: RequestContext
  ): Promise<PostOutcome> {
    const budget = Math.min(ctx.requestTimeoutMs, remainingBudget(ctx));
    if (budget <= 0) return { kind: 'transport' };

    try {
      const response = await ctx.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(budget),
      });

      if (response.status === 401) return { kind: 'auth' };

      if (response.status === 403) {
        const errorBody = await this.readJson(response);
        // A generic 403 is IAM or policy denial, not evidence of a missing scope.
        return containsScopeError(errorBody) ? { kind: 'scope' } : { kind: 'transport' };
      }

      if (!response.ok) return { kind: 'transport' };

      const data = await this.readJson(response);
      if (!isRecord(data)) return { kind: 'transport' };
      return { kind: 'ok', data };
    } catch {
      return { kind: 'transport' };
    }
  }

  private static async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  /**
   * Try each host in order. A 401 or an explicit scope failure is conclusive, so
   * it short-circuits instead of burning the remaining deadline on a mirror.
   */
  private static async postFirst(
    urls: readonly string[],
    body: unknown,
    accessToken: string,
    ctx: RequestContext
  ): Promise<PostOutcome> {
    let last: PostOutcome = { kind: 'transport' };
    for (const url of urls) {
      if (remainingBudget(ctx) <= 0) break;
      const outcome = await this.post(url, body, accessToken, ctx);
      if (outcome.kind !== 'transport') return outcome;
      last = outcome;
    }
    return last;
  }

  /** Plan name and, when the profile has none, the Cloud Code companion project. */
  public static async loadCodeAssist(
    accessToken: string,
    ctx: RequestContext
  ): Promise<CodeAssistInfo> {
    const outcome = await this.postFirst(
      LOAD_CODE_ASSIST_ENDPOINTS,
      { metadata: { ideType: 'ANTIGRAVITY' } },
      accessToken,
      ctx
    );
    if (outcome.kind !== 'ok') return { outcome: outcome.kind };

    const paidTier = isRecord(outcome.data.paidTier) ? outcome.data.paidTier : undefined;
    const currentTier = isRecord(outcome.data.currentTier) ? outcome.data.currentTier : undefined;

    return {
      outcome: 'ok',
      plan: nonEmptyString(paidTier?.name, 128) ?? nonEmptyString(currentTier?.name, 128),
      project: nonEmptyString(outcome.data.cloudaicompanionProject, 128),
    };
  }

  /**
   * Exchange a refresh token for a fresh access token using environment-supplied
   * OAuth client configuration only. Returns null when the environment does not
   * provide a client ID, which is the normal case for a default install.
   */
  private static async refreshAccessToken(
    stored: RefreshedToken,
    ctx: RequestContext,
    env: NodeJS.ProcessEnv,
    account: Account
  ): Promise<RefreshedToken | null> {
    const refreshToken = stored.refresh_token;
    if (!refreshToken) return null;

    const client = getOAuthClientConfig(env);
    if (!client) return null;
    if (!this.mayRefreshWith(account, client)) return null;

    const budget = Math.min(ctx.requestTimeoutMs, remainingBudget(ctx));
    if (budget <= 0) return null;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
    });
    if (client.clientSecret) params.set('client_secret', client.clientSecret);

    try {
      const response = await ctx.fetchFn(OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: params.toString(),
        signal: AbortSignal.timeout(budget),
      });
      if (!response.ok) return null;

      const data = await this.readJson(response);
      if (!isRecord(data)) return null;

      const accessToken = nonEmptyString(data.access_token, 8192);
      if (!accessToken) return null;

      const expiresIn =
        typeof data.expires_in === 'number' &&
        Number.isFinite(data.expires_in) &&
        data.expires_in > 0
          ? data.expires_in
          : 3600;

      return {
        access_token: accessToken,
        // Honour a rotated refresh token when Google returns one.
        refresh_token: nonEmptyString(data.refresh_token, 8192) ?? refreshToken,
        token_type: nonEmptyString(data.token_type, 64) ?? stored.token_type ?? 'Bearer',
        expiry: new Date(ctx.now() + expiresIn * 1000).toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Whether the configured OAuth client is entitled to refresh this account.
   *
   * Google binds a refresh token to the client that issued it, so offering one
   * to a different client both fails and discloses the credential to an
   * application that was never involved in issuing it. Only a profile known to
   * have come from this very client may be refreshed here; a native Antigravity
   * session is refreshed by Antigravity itself, and a profile of unrecorded
   * origin is not assumed to be safe to try.
   */
  private static mayRefreshWith(account: Account, client: OAuthClientConfig): boolean {
    if (account.credentialSource !== 'custom-client') return false;
    return !account.oauthClientId || account.oauthClientId === client.clientId;
  }

  /** The token can no longer be used at all. */
  private static isTokenExpired(expiry: string | undefined, nowMs: number): boolean {
    if (!expiry) return false;
    const expiryMs = Date.parse(expiry);
    if (!Number.isFinite(expiryMs)) return false;
    return nowMs >= expiryMs;
  }

  /**
   * The token is close enough to expiry to be worth replacing before use.
   *
   * This is an opportunity, not a verdict: a token inside the window is still
   * valid, so failing to replace it early is not the same as it having expired.
   */
  private static isRefreshDue(expiry: string | undefined, nowMs: number): boolean {
    if (!expiry) return false;
    const expiryMs = Date.parse(expiry);
    if (!Number.isFinite(expiryMs)) return false;
    return nowMs >= expiryMs - TOKEN_REFRESH_BUFFER_SECONDS * 1000;
  }

  /**
   * Refresh live plan and quota for one account under a single bounded deadline.
   * Never mutates the account: the caller applies the returned state through the
   * locked registry transaction.
   */
  public static async refreshAccountQuota(
    account: Account,
    options: QuotaOptions = {}
  ): Promise<QuotaRefresh> {
    const now = options.now ?? (() => Date.now());
    const base = { accountId: account.id, observedUpdatedAt: account.updatedAt };

    if (account.authType !== 'oauth') {
      return { result: { ...base, ok: false, reason: 'not-applicable' } };
    }

    const stored = account.credentials?.keychainPayload?.token;
    if (!stored?.access_token) {
      return { result: { ...base, ok: false, reason: 'not-applicable' } };
    }

    const ctx: RequestContext = {
      fetchFn: options.fetchFn ?? globalThis.fetch,
      now,
      endsAt: now() + (options.deadlineMs ?? DEFAULT_QUOTA_DEADLINE_MS),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_QUOTA_REQUEST_TIMEOUT_MS,
    };

    let accessToken = stored.access_token;
    let tokenUpdate: TokenUpdate | undefined;

    if (this.isRefreshDue(stored.expiry, now())) {
      const refreshed = await this.refreshAccessToken(
        stored,
        ctx,
        options.env ?? process.env,
        account
      );
      if (refreshed) {
        accessToken = refreshed.access_token;
        tokenUpdate = new TokenUpdate(refreshed);
      } else if (this.isTokenExpired(stored.expiry, now())) {
        // Nothing left to try: the token is spent and could not be replaced.
        // Say which, so the caller can point at Antigravity rather than at a
        // client configuration the user is not expected to have.
        const reason =
          account.credentialSource === 'antigravity' ? 'native-refresh-required' : 'token-expired';
        return {
          result: { ...base, ok: false, reason, status: 'expired' },
        };
      }
      // Otherwise the stored token still has life in it; carry on with it.
    }

    // Contract A first: it needs no project and answers in one round trip.
    const summary = await this.postFirst(QUOTA_SUMMARY_ENDPOINTS, {}, accessToken, ctx);
    if (summary.kind === 'ok') {
      const snapshot = buildSnapshot(collectFromSummary(summary.data));
      if (hasUsableWindows(snapshot)) {
        const info = await this.loadCodeAssist(accessToken, ctx);
        return {
          result: {
            ...base,
            ok: true,
            status: 'valid',
            rateLimit: snapshot,
            quotaCheckedAt: now(),
            ...(info.plan ? { plan: info.plan } : {}),
            ...(info.project && !account.gcpProject ? { discoveredProject: info.project } : {}),
          },
          tokenUpdate,
        };
      }
    }

    // Contract B needs a real project. Discovery may supply one; nothing invents one.
    const info = await this.loadCodeAssist(accessToken, ctx);
    const discoveredProject = info.project && !account.gcpProject ? info.project : undefined;
    const projectId = info.project ?? account.gcpProject;
    const carried = {
      ...(info.plan ? { plan: info.plan } : {}),
      ...(discoveredProject ? { discoveredProject } : {}),
    };

    const quota: PostOutcome = projectId
      ? await this.postFirst(
          RETRIEVE_USER_QUOTA_ENDPOINTS,
          { project: projectId },
          accessToken,
          ctx
        )
      : { kind: 'transport' };

    if (quota.kind === 'ok') {
      const snapshot = buildSnapshot(collectFromBuckets(quota.data));
      if (hasUsableWindows(snapshot)) {
        return {
          result: {
            ...base,
            ok: true,
            status: 'valid',
            rateLimit: snapshot,
            quotaCheckedAt: now(),
            ...carried,
          },
          tokenUpdate,
        };
      }
    }

    const outcomes = [summary.kind, info.outcome, quota.kind];

    if (outcomes.includes('scope')) {
      return {
        result: {
          ...base,
          ok: false,
          reason: 'scope-insufficient',
          status: 'needs-reauth',
          ...carried,
        },
        tokenUpdate,
      };
    }

    if (outcomes.includes('auth')) {
      return {
        result: { ...base, ok: false, reason: 'auth-failed', status: 'expired', ...carried },
        tokenUpdate,
      };
    }

    // A syntactically valid response with no recognized window is not a success,
    // but it says nothing about the credential: keep status and cached quota.
    //
    // Any contract answering with HTTP 200 proves the service was reachable, so
    // the honest reason is that quota is unavailable rather than that the network
    // failed. Observed in the wild: `loadCodeAssist` answers 200 while both quota
    // contracts answer 429.
    const hadPayload = summary.kind === 'ok' || quota.kind === 'ok' || info.outcome === 'ok';
    return {
      result: {
        ...base,
        ok: false,
        reason: hadPayload ? 'quota-unavailable' : 'network-error',
        ...carried,
      },
      tokenUpdate,
    };
  }

  /**
   * Refresh several accounts with bounded concurrency. One account's failure
   * never aborts the batch.
   */
  public static async refreshAccountQuotas(
    accounts: Account[],
    options: QuotaOptions = {}
  ): Promise<Map<string, QuotaRefresh>> {
    const results = new Map<string, QuotaRefresh>();

    for (let i = 0; i < accounts.length; i += QUOTA_REFRESH_CONCURRENCY) {
      const chunk = accounts.slice(i, i + QUOTA_REFRESH_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((account) => this.refreshAccountQuota(account, options))
      );

      for (let j = 0; j < chunk.length; j++) {
        const account = chunk[j];
        const outcome = settled[j];
        results.set(
          account.id,
          outcome.status === 'fulfilled'
            ? outcome.value
            : {
                result: {
                  accountId: account.id,
                  observedUpdatedAt: account.updatedAt,
                  ok: false,
                  reason: 'network-error',
                },
              }
        );
      }
    }

    return results;
  }
}

/**
 * One endpoint call, reduced to what can be read out loud: the HTTP status and
 * the response's shape. Values are kept only where they classify a bucket
 * (window names, reset times, fractions); anything long or identifying is
 * replaced by its length.
 */
export interface QuotaProbeStep {
  endpoint: string;
  request: string;
  status: number | 'network-error' | 'skipped';
  shape: string;
}

function describeString(value: string): string {
  if (value.length > 120 || value.includes('@')) return `string(${value.length})`;
  return JSON.stringify(value);
}

function describeShape(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= 4) return `[${value.length}]`;
    return `[${value.length} x ${describeShape(value[0], depth + 1)}]`;
  }
  if (isRecord(value)) {
    if (depth >= 4) return '{..}';
    const keys = Object.keys(value);
    const shown = keys.slice(0, 16).map((key) => `${key}: ${describeShape(value[key], depth + 1)}`);
    if (keys.length > shown.length) shown.push('..');
    return `{ ${shown.join(', ')} }`;
  }
  if (typeof value === 'string') return describeString(value);
  return String(value);
}

/**
 * Call every quota contract once and report what came back. This exists because
 * the endpoints are undocumented: when a reading stops parsing, the only way to
 * tell a changed contract from an empty entitlement is to look at the answer.
 */
export async function probeQuotaEndpoints(
  account: Account,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {}
): Promise<QuotaProbeStep[]> {
  const accessToken = account.credentials?.keychainPayload?.token?.access_token;
  if (!accessToken) {
    throw new Error('Account has no stored access token to probe with.');
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUOTA_REQUEST_TIMEOUT_MS;
  const steps: QuotaProbeStep[] = [];

  const call = async (endpoint: string, body: Record<string, unknown>): Promise<unknown> => {
    const request = describeShape(body);
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = undefined;
      }
      steps.push({ endpoint, request, status: response.status, shape: describeShape(data) });
      return response.ok ? data : undefined;
    } catch {
      steps.push({ endpoint, request, status: 'network-error', shape: '-' });
      return undefined;
    }
  };

  // loadCodeAssist first: it is the only call that can supply a project id, and
  // both quota contracts declare one in their request.
  let discoveredProject: string | undefined;
  for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    const data = await call(endpoint, { metadata: { ideType: 'ANTIGRAVITY' } });
    if (isRecord(data) && !discoveredProject) {
      discoveredProject = nonEmptyString(data.cloudaicompanionProject, 128);
    }
  }

  const project = account.gcpProject ?? discoveredProject;

  // Both bodies for the summary, because agy-auth sends the empty one today and
  // the published request message has a project field.
  for (const endpoint of QUOTA_SUMMARY_ENDPOINTS) {
    await call(endpoint, {});
    if (project) await call(endpoint, { project });
  }

  for (const endpoint of RETRIEVE_USER_QUOTA_ENDPOINTS) {
    if (!project) {
      steps.push({ endpoint, request: '-', status: 'skipped', shape: 'no project id known' });
      continue;
    }
    await call(endpoint, { project });
  }

  return steps;
}
