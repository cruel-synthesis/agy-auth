import { AccountScore, chooseBestAccount } from '../core/best-account.js';
import { CliError, UsageError } from '../core/errors.js';
import { applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { Switcher } from '../core/switcher.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';
import { refreshQuota, selectStale } from './refresh.js';

interface AutoOptions {
  dryRun?: boolean;
  json?: boolean;
  offline?: boolean;
  quotaOptions?: QuotaOptions;
}

/** A coarse countdown: precision past the leading unit is noise here. */
function formatUntil(resetsAt: number | undefined, nowMs: number): string {
  if (resetsAt === undefined) return '-';
  const minutes = Math.round((resetsAt * 1000 - nowMs) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const days = Math.floor(minutes / 1440);
  return `${days}d ${Math.floor((minutes % 1440) / 60)}h`;
}

function percent(fraction: number | undefined): string {
  return fraction === undefined ? '-' : `${Math.round(fraction * 100)}%`;
}

/** One line per account: what it has left, when it expires, and where it ranked. */
function renderRanking(ranked: AccountScore[], activeId: string | null, nowMs: number): string[] {
  const rows = ranked.map((entry) => ({
    marker: entry.account.id === activeId ? '*' : ' ',
    name: formatAccountShort(entry.account),
    // No scored family means nothing was measured; 0% would claim otherwise.
    headroom: entry.perishing ? percent(entry.headroom) : '-',
    weekly: percent(entry.perishing?.remaining),
    expires: formatUntil(entry.perishing?.resetsAt, nowMs),
    note: entry.blocked ?? entry.score.toFixed(3),
  }));

  const width = (pick: (row: (typeof rows)[number]) => string, header: string) =>
    Math.max(header.length, ...rows.map((row) => pick(row).length));
  const nameWidth = width((row) => row.name, 'ACCOUNT');
  const headroomWidth = width((row) => row.headroom, '5H');
  const weeklyWidth = width((row) => row.weekly, 'WEEK');
  const expiresWidth = width((row) => row.expires, 'EXPIRES');

  const header = colors.dim(
    `    ${'ACCOUNT'.padEnd(nameWidth)}  ${'5H'.padEnd(headroomWidth)}  ${'WEEK'.padEnd(weeklyWidth)}  ${'EXPIRES'.padEnd(expiresWidth)}  SCORE`
  );

  return [
    header,
    ...rows.map((row) => {
      const line = `${row.name.padEnd(nameWidth)}  ${row.headroom.padEnd(headroomWidth)}  ${row.weekly.padEnd(weeklyWidth)}  ${row.expires.padEnd(expiresWidth)}  ${row.note}`;
      return `  ${row.marker} ${line}`;
    }),
  ];
}

/** Why the winner won, in the terms that decided it. */
function explain(best: AccountScore, nowMs: number): string {
  const weekly = best.perishing;
  if (!weekly || weekly.resetsAt === undefined) {
    return `It has the most room to work: ${percent(best.headroom)} of the 5-hour limit left.`;
  }
  return (
    `${percent(weekly.remaining)} of its weekly limit is unspent and expires in ` +
    `${formatUntil(weekly.resetsAt, nowMs)} - the quota most likely to go to waste.`
  );
}

export async function autoCommand(options: AutoOptions = {}): Promise<void> {
  const registry = new RegistryManager();
  const accounts = registry.getAccounts();

  if (accounts.length === 0) {
    throw new UsageError('No accounts registered. Run `agy-auth login` to add an account.');
  }

  if (!options.offline) {
    const refresh = await refreshQuota(selectStale(accounts), false, options.quotaOptions);
    await applyQuotaResults(registry, refresh.refreshes);
  }

  // Re-read: the choice must be made on the readings just written, not the ones
  // loaded before the refresh.
  const fresh = registry.getRegistry();
  const activeId = fresh.activeAccountId;
  const nowMs = Date.now();
  const choice = chooseBestAccount(fresh.accounts, activeId, nowMs);

  // The ranking explains the verdict, including a verdict of `none`, so it is
  // printed before the failure rather than instead of it.
  if (!options.json) {
    console.log('');
    for (const line of renderRanking(choice.ranked, activeId, nowMs)) {
      console.log(line);
    }
    console.log('');
  }

  if (!choice.best) {
    const soonest = choice.ranked
      .map((entry) => entry.refillsAt)
      .filter((at): at is number => at !== undefined)
      .sort((a, b) => a - b)[0];
    throw new CliError(
      soonest === undefined
        ? 'No account has quota to work with. Run `agy-auth list --check` for a live reading.'
        : `Every account is out of 5-hour quota. The first frees up in ${formatUntil(soonest, nowMs)}.`
    );
  }

  const switched = choice.shouldSwitch && !options.dryRun;
  const result = switched ? Switcher.switchAccount(choice.best.account) : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'auto',
          ok: true,
          data: {
            switched,
            activeAccountId: result?.currentAccount.id ?? activeId,
            chosenAccountId: choice.best.account.id,
            ranking: choice.ranked.map((entry) => ({
              accountId: entry.account.id,
              email: entry.account.email,
              score: entry.score,
              headroom: entry.headroom,
              weeklyRemaining: entry.perishing?.remaining,
              weeklyResetsAt: entry.perishing?.resetsAt,
              blocked: entry.blocked,
            })),
            warnings: result?.warnings?.length ? result.warnings : undefined,
          },
        },
        null,
        2
      )
    );
    return;
  }

  for (const warning of result?.warnings ?? []) {
    console.error(colors.yellow(`  Warning: ${warning}`));
  }

  const name = colors.green(formatAccountShort(choice.best.account));
  const verdict = switched
    ? `Switched to ${name}`
    : choice.shouldSwitch
      ? `Would switch to ${name}`
      : `Staying on ${name} - already the best use of your quota.`;

  console.log(`  ${verdict}`);
  console.log(`  ${colors.dim(explain(choice.best, nowMs))}\n`);
}
