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
    console.log(colors.yellow(warning));
  }

  console.log(`Account:      ${colors.green(formatAccountShort(active))}`);
  console.log(`Auth method:  ${formatAuthType(active.authType)}`);
  console.log(
    `GCP project:  ${active.gcpProject || 'None'}${active.gcpLocation ? ` (${active.gcpLocation})` : ''}`
  );
  console.log(
    `Model:        ${active.model || 'Default'}${active.reasoningEffort ? ` [Effort: ${active.reasoningEffort}]` : ''}`
  );
  console.log(`Status:       ${formatStatus(active.status, true)}`);
  for (const line of quotaSummaryLines(active)) {
    console.log(line);
  }
  if (active.verification) {
    console.log(
      `Verification: Checked ${formatTimeAgo(active.verification.checkedAt)} (${active.verification.source}) - ${active.verification.message || 'OK'}`
    );
  }
}
