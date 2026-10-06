import { AccountNotFoundError, AmbiguousSelectorError, UsageError } from '../core/errors.js';
import { applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions, QuotaRefreshSummary, summarizeQuotaRefresh } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { Account, sanitizeAccount } from '../core/types.js';
import {
  NO_ACCOUNTS,
  formatAccountShort,
  detailLine,
  formatAuthType,
  formatDay,
  formatStatus,
  formatTimeAgo,
  quotaSummaryLines,
} from '../ui/format.js';
import { colors } from '../ui/theme.js';
import { promptSelectAccount } from '../ui/tui.js';
import { refreshQuota } from './refresh.js';

interface DetailsOptions {
  json?: boolean;
  refresh?: boolean;
  quotaOptions?: QuotaOptions;
}

function renderAccountDetails(account: Account, isActive: boolean): void {
  const activeBadge = isActive ? colors.green(' (Active Account)') : '';
  const lines = [
    detailLine('Account', `${colors.cyanBold(formatAccountShort(account))}${activeBadge}`),
    detailLine('Auth method', formatAuthType(account.authType)),
    detailLine('Status', formatStatus(account.status, isActive)),
    detailLine(
      'GCP project',
      `${account.gcpProject || colors.dim('Not set')}${account.gcpLocation ? ` (${account.gcpLocation})` : ''}`
    ),
    detailLine(
      'Model',
      `${account.model || colors.dim('Not set')}${account.reasoningEffort ? ` [Effort: ${account.reasoningEffort}]` : ''}`
    ),
    ...quotaSummaryLines(account),
  ];
  if (account.lastUsedAt) lines.push(detailLine('Last active', formatTimeAgo(account.lastUsedAt)));
  lines.push(detailLine('Added', formatDay(new Date(account.createdAt))));
  if (account.verification) {
    lines.push(
      detailLine(
        'Verification',
        `Checked ${formatTimeAgo(account.verification.checkedAt)} (${account.verification.source}) - ${account.verification.message || 'OK'}`
      )
    );
  }
  console.log(lines.join('\n'));
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
              quotaRefresh: summarizeQuotaRefresh(!options.refresh, []),
            },
          },
          null,
          2
        )
      );
      return;
    }
    console.log(NO_ACCOUNTS);
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
        `Multiple accounts matched '${query}'. Select one:`
      );
      if (!target) return;
    } else {
      target = matches[0];
    }
  } else if (!process.stdout.isTTY || options.json) {
    if (!active) {
      throw new UsageError('No account is selected; provide an account selector.');
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

  const offline = !options.refresh;
  let quotaSummary: QuotaRefreshSummary = summarizeQuotaRefresh(offline, []);
  let warning: string | undefined;

  if (!offline) {
    const refresh = await refreshQuota([target], options.quotaOptions);
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
    console.error(colors.yellow(`Warning: ${warning}`));
  }
  renderAccountDetails(target, isActive);
}
