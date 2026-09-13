import { AccountNotFoundError, AmbiguousSelectorError, UsageError } from '../core/errors.js';
import { applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions, QuotaRefreshSummary, summarizeQuotaRefresh } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { Account, sanitizeAccount } from '../core/types.js';
import {
  formatAccountShort,
  formatAuthType,
  formatStatus,
  formatTimeAgo,
  quotaSummaryLines,
} from '../ui/format.js';
import { colors } from '../ui/theme.js';
import { promptSelectAccount } from '../ui/tui.js';
import { refreshQuota } from './refresh.js';

interface DetailsOptions {
  json?: boolean;
  offline?: boolean;
  quotaOptions?: QuotaOptions;
}

export function renderAccountDetails(account: Account, isActive: boolean): void {
  const activeBadge = isActive ? colors.green(' (Active Account)') : '';
  console.log(`Account:      ${colors.cyan(formatAccountShort(account))}${activeBadge}`);
  console.log(`Auth method:  ${formatAuthType(account.authType)}`);
  console.log(`Status:       ${formatStatus(account.status, isActive)}`);
  console.log(
    `GCP project:  ${account.gcpProject || 'Not set'}${account.gcpLocation ? ` (${account.gcpLocation})` : ''}`
  );
  console.log(
    `Model:        ${account.model || 'Not set'}${account.reasoningEffort ? ` [Effort: ${account.reasoningEffort}]` : ''}`
  );
  for (const line of quotaSummaryLines(account)) {
    console.log(line);
  }
  if (account.lastUsedAt) {
    console.log(`Last active:  ${formatTimeAgo(account.lastUsedAt)}`);
  }
  console.log(`Added:        ${new Date(account.createdAt).toLocaleDateString()}`);
  if (account.verification) {
    console.log(
      `Verification: Checked ${formatTimeAgo(account.verification.checkedAt)} (${account.verification.source}) - ${account.verification.message || 'OK'}`
    );
  }
}

export async function detailsCommand(query?: string, options: DetailsOptions = {}): Promise<void> {
  const registry = new RegistryManager();
  const accounts = registry.getAccounts();
  const active = registry.getActiveAccount();

  if (accounts.length === 0) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'details',
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
    console.log('No accounts found in registry. Run `agy-auth add` or `agy-auth login` first.');
    return;
  }

  let target: Account | null = null;

  if (query?.trim()) {
    const matches = registry.findAccounts(query);
    if (matches.length === 0) {
      throw new AccountNotFoundError(query);
    }
    if (matches.length > 1) {
      if (!process.stdout.isTTY || options.json) {
        throw new AmbiguousSelectorError(
          query,
          matches.map((m) => m.alias || m.email)
        );
      }
      target = await promptSelectAccount(
        matches,
        active?.id || null,
        `Multiple profiles matched '${query}'. Select one:`
      );
      if (!target) return;
    } else {
      target = matches[0];
    }
  } else if (!process.stdout.isTTY || options.json) {
    if (!active) {
      throw new UsageError('No profile is selected; provide an account selector.');
    }
    target = active;
  } else {
    const selected = await promptSelectAccount(
      accounts,
      active?.id || null,
      'Select account to view details:'
    );
    if (!selected) {
      return;
    }
    target = selected;
  }

  if (!target) return;

  const offline = Boolean(options.offline);
  let quotaSummary: QuotaRefreshSummary = summarizeQuotaRefresh(offline, []);
  let warning: string | undefined;

  if (!offline) {
    const refresh = await refreshQuota([target], false, options.quotaOptions);
    quotaSummary = refresh.summary;
    warning = refresh.warning;
    await applyQuotaResults(registry, refresh.refreshes);
    target = registry.findAccount(target.id) || target;
  }

  const isActive = target.id === active?.id;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'details',
          ok: true,
          data: {
            account: sanitizeAccount(target),
            isActive,
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
  renderAccountDetails(target, isActive);
}
