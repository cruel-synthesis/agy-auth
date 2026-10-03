import { UsageError } from '../core/errors.js';
import { applyCheckResults, applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions, summarizeQuotaRefresh } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { Account, sanitizeAccounts } from '../core/types.js';
import { Verifier } from '../core/verifier.js';
import { renderAccountsTable } from '../ui/table.js';
import { colors } from '../ui/theme.js';
import { refreshQuota, selectStale } from './refresh.js';

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

  // An --active filter matching nothing is not an empty registry, and the table
  // renderer sees only the filtered list, so it reports one as the other.
  if (options.active && displayAccounts.length === 0 && freshAccounts.length > 0) {
    console.log(
      `\n  No active account. Run ${colors.cyan('agy-auth switch <account>')} to select one.\n`
    );
    return;
  }

  if (warning) {
    console.log(colors.yellow(`  Warning: ${warning}`));
  }
  console.log(renderAccountsTable(displayAccounts, freshActiveAccountId));
}
