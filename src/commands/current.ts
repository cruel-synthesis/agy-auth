import { applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions, QuotaRefreshSummary, summarizeQuotaRefresh } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { sanitizeAccount } from '../core/types.js';
import {
  NO_ACCOUNTS,
  formatAccountShort,
  formatAuthType,
  formatStatus,
  formatTimeAgo,
  quotaSummaryLines,
} from '../ui/format.js';
import { colors } from '../ui/theme.js';
import { refreshQuota } from './refresh.js';

interface CurrentOptions {
  json?: boolean;
  offline?: boolean;
  quotaOptions?: QuotaOptions;
}

export async function currentCommand(options: CurrentOptions = {}): Promise<void> {
  const registry = new RegistryManager();
  let active = registry.getActiveAccount();

  if (!active) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'current',
            ok: true,
            data: {
              account: null,
              quotaRefresh: summarizeQuotaRefresh(Boolean(options.offline), []),
            },
          },
          null,
          2
        )
      );
      return;
    }
    console.log(
      registry.getAccounts().length === 0
        ? NO_ACCOUNTS
        : 'No active account. Run `agy-auth switch` to choose one.'
    );
    return;
  }

  const offline = Boolean(options.offline);
  let quotaSummary: QuotaRefreshSummary = summarizeQuotaRefresh(offline, []);
  let warning: string | undefined;

  if (!offline) {
    const refresh = await refreshQuota([active], false, options.quotaOptions);
    quotaSummary = refresh.summary;
    warning = refresh.warning;
    await applyQuotaResults(registry, refresh.refreshes);
    active = registry.getActiveAccount() || active;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'current',
          ok: true,
          data: {
            account: sanitizeAccount(active),
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
    console.error(colors.yellow(`Warning: ${warning}`));
  }

  console.log(`Account:      ${colors.green(formatAccountShort(active))}`);
  console.log(`Auth method:  ${formatAuthType(active.authType)}`);
  console.log(`Status:       ${formatStatus(active.status, true)}`);
  for (const line of quotaSummaryLines(active)) {
    console.log(line);
  }
  if (active.lastUsedAt) {
    console.log(`Last active:  ${formatTimeAgo(active.lastUsedAt)}`);
  }

  // Project, model and verification detail are configuration rather than
  // status, so they live in `details`. Point there only when this account
  // actually carries some, otherwise the hint is noise.
  if (active.gcpProject || active.model || active.verification) {
    console.log(colors.dim('\nRun `agy-auth details` for project, model and verification.'));
  }
}
