import {
  QuotaClient,
  QuotaFailureReason,
  QuotaOptions,
  QuotaRefresh,
  QuotaRefreshSummary,
  summarizeQuotaRefresh,
} from '../core/quota.js';
import { Account, needsSignIn } from '../core/types.js';

const REASON_TEXT: Record<QuotaFailureReason, string> = {
  'not-applicable': 'no usable OAuth token on the account',
  'native-refresh-required':
    'Antigravity owns this session; sign in through Antigravity, then run `agy-auth add`',
  'token-expired': 'token expired; sign in through Antigravity, then run `agy-auth add`',
  'scope-insufficient':
    'token is missing the required scopes; sign in through Antigravity, then run `agy-auth add`',
  'auth-failed':
    'authentication was rejected; sign in through Antigravity, then run `agy-auth add`',
  'quota-unavailable': 'the service did not return recognized quota data',
  'network-error': 'network or service error',
};

export function describeQuotaFailure(reason: QuotaFailureReason | undefined): string {
  return reason ? REASON_TEXT[reason] : 'unknown error';
}

export interface QuotaRefreshOutcome {
  refreshes: QuotaRefresh[];
  summary: QuotaRefreshSummary;
  /** One concise warning, without a `Warning:` prefix, present only when a refresh failed. */
  warning?: string;
}

/** Live quota only applies to OAuth accounts; nothing else is contacted. */
export function selectRefreshable(accounts: Account[]): Account[] {
  return accounts.filter((account) => account.authType === 'oauth');
}

/** How long a live quota reading is treated as current. */
export const QUOTA_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * A window that reset since it was read describes a period that is over. Its
 * usage number is no longer a reading of anything, whatever the cache TTL says.
 * A reset time already past when it was read says nothing new, so it waits for
 * the TTL like any other reading.
 */
function hasElapsedWindow(account: Account, nowMs: number): boolean {
  const readAtMs = account.quotaCheckedAt ?? 0;
  return [account.rateLimit?.gemini, account.rateLimit?.claude].some((family) =>
    [family?.rate5h, family?.rateWeekly].some((window) => {
      if (window?.resetsAt === undefined) return false;
      const resetMs = window.resetsAt * 1000;
      return resetMs >= readAtMs && nowMs >= resetMs;
    })
  );
}

/**
 * The accounts an ordinary read contacts: every OAuth account whose reading has
 * aged out or has outlived its own reset time, not just the active one - the
 * table shows them all, so a row that is never refreshed is never right.
 * Accounts already known to need a fresh sign-in are left alone; they would
 * spend a round trip each time to learn nothing. `list --check` still asks about
 * every account.
 */
export function selectStale(accounts: Account[]): Account[] {
  const nowMs = Date.now();
  const cutoff = nowMs - QUOTA_CACHE_TTL_MS;
  return selectRefreshable(accounts).filter(
    (account) =>
      !needsSignIn(account) &&
      ((account.quotaCheckedAt ?? 0) <= cutoff || hasElapsedWindow(account, nowMs))
  );
}

/**
 * Best-effort live refresh for the given accounts. Failures are reported, never
 * thrown: the caller still renders whatever cached data exists.
 */
export async function refreshQuota(
  accounts: Account[],
  offline: boolean,
  options: QuotaOptions = {}
): Promise<QuotaRefreshOutcome> {
  const targets = offline ? [] : selectRefreshable(accounts);
  if (targets.length === 0) {
    return { refreshes: [], summary: summarizeQuotaRefresh(offline, []) };
  }

  const results = await QuotaClient.refreshAccountQuotas(targets, options);
  const refreshes = targets
    .map((account) => results.get(account.id))
    .filter(Boolean) as QuotaRefresh[];

  const failed = refreshes.filter((refresh) => !refresh.result.ok);
  let warning: string | undefined;

  if (failed.length === 1) {
    const account = targets.find((a) => a.id === failed[0].result.accountId);
    warning =
      `Could not refresh live quota for ${account?.alias || account?.email || failed[0].result.accountId} ` +
      `(${describeQuotaFailure(failed[0].result.reason)}). Showing cached quota where available.`;
  } else if (failed.length > 1) {
    const reasons = [...new Set(failed.map((f) => describeQuotaFailure(f.result.reason)))].join(
      '; '
    );
    warning =
      `Could not refresh live quota for ${failed.length} of ${refreshes.length} accounts ` +
      `(${reasons}). Showing cached quota where available.`;
  }

  return {
    refreshes,
    summary: summarizeQuotaRefresh(offline, refreshes),
    ...(warning ? { warning } : {}),
  };
}
