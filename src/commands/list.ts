import { UsageError } from '../core/errors.js';
import { applyCheckResults, applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions, summarizeQuotaRefresh } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { Account, sanitizeAccounts } from '../core/types.js';
import { Verifier } from '../core/verifier.js';
import { renderAccountsTable } from '../ui/table.js';
import { colors } from '../ui/theme.js';
import { refreshQuota, selectRefreshable } from './refresh.js';

/** How long a live quota reading is treated as current. */
const QUOTA_CACHE_TTL_MS = 10 * 60 * 1000;

/** Statuses that cannot improve until the user signs in again. */
const NEEDS_USER_ACTION: ReadonlySet<string> = new Set(['expired', 'invalid', 'needs-reauth']);

/**
 * The profiles an ordinary `list` contacts: every OAuth profile whose reading has
 * aged out, not just the active one - the table shows them all, so a row that is
 * never refreshed is never right. Profiles already known to need a fresh sign-in
 * are left alone; they would spend a round trip each time to learn nothing.
 * `--check` still asks about every profile.
 */
function selectStale(accounts: Account[]): Account[] {
  const cutoff = Date.now() - QUOTA_CACHE_TTL_MS;
  return selectRefreshable(accounts).filter(
    (account) => !NEEDS_USER_ACTION.has(account.status) && (account.quotaCheckedAt ?? 0) <= cutoff
  );
}

interface ListOptions {
  active?: boolean;
  check?: boolean;
  json?: boolean;
  offline?: boolean;
  quotaOptions?: QuotaOptions;
}

export async function listCommand(options: ListOptions): Promise<void> {
  if (options.check && options.offline) {
    throw new UsageError(
      '`--check` performs live verification and cannot be combined with `--offline`.'
    );
  }

  const registry = new RegistryManager();
  let accounts = registry.getAccounts();
  const activeAccountId = registry.getActiveAccount()?.id || null;

  if (options.active) {
    accounts = accounts.filter((a) => a.id === activeAccountId);
  }

  const offline = Boolean(options.offline);
  let quotaSummary = summarizeQuotaRefresh(offline, []);
  let warning: string | undefined;

  if (options.check && accounts.length > 0) {
    if (!options.json) {
      console.log('Verifying accounts...');
    }
    const verifications = await Verifier.verifyAccounts(accounts);
    const refresh = await refreshQuota(accounts, false, options.quotaOptions);
    quotaSummary = refresh.summary;
    warning = refresh.warning;

    const quotas = new Map(refresh.refreshes.map((r) => [r.result.accountId, r]));
    await applyCheckResults(registry, verifications, quotas);
  } else if (!offline && accounts.length > 0) {
    const refresh = await refreshQuota(selectStale(accounts), false, options.quotaOptions);
    quotaSummary = refresh.summary;
    warning = refresh.warning;
    await applyQuotaResults(registry, refresh.refreshes);
  }

  // Reload fresh accounts for display
  const freshRegistry = registry.getRegistry();
  const freshAccounts = freshRegistry.accounts;
  const freshActiveAccountId = freshRegistry.activeAccountId;
  const displayAccounts = options.active
    ? freshAccounts.filter((a) => a.id === freshActiveAccountId)
    : freshAccounts;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'list',
          ok: true,
          data: {
            activeAccountId: freshActiveAccountId,
            total: displayAccounts.length,
            accounts: sanitizeAccounts(displayAccounts),
            quotaRefresh: quotaSummary,
          },
        },
        null,
        2
      )
    );
    return;
  }

  if (warning) {
    console.log(colors.yellow(`  ${warning}`));
  }
  console.log(renderAccountsTable(displayAccounts, freshActiveAccountId));
}
