import { setTimeout as delay } from 'node:timers/promises';
import { AccountScore, chooseBestAccount } from '../core/best-account.js';
import { CancellationError, CliError, UsageError } from '../core/errors.js';
import { applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { Switcher } from '../core/switcher.js';
import { Account } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';
import { refreshQuota, selectRefreshable, selectStale } from './refresh.js';

interface AutoOptions {
  dryRun?: boolean;
  interval?: string;
  json?: boolean;
  offline?: boolean;
  quotaOptions?: QuotaOptions;
  watch?: boolean;
}

const DEFAULT_INTERVAL_MINUTES = 5;

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

/** Take a live reading for these accounts and write it to the registry. */
async function refreshAndApply(
  registry: RegistryManager,
  accounts: Account[],
  options: AutoOptions
): Promise<void> {
  const refresh = await refreshQuota(accounts, false, options.quotaOptions);
  await applyQuotaResults(registry, refresh.refreshes);
}

function clockOf(nowMs: number): string {
  const at = new Date(nowMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** What one watch check found, ready to print either way. */
interface TickReport {
  event: 'holding' | 'switched' | 'would-switch' | 'exhausted' | 'switch-failed' | 'idle';
  detail: string;
  activeAccountId: string | null;
  chosenAccountId?: string;
}

/**
 * One watch check: renew the reading for the account in use and, if it can no
 * longer take work, move to the best of the others.
 *
 * Only the account in use is contacted while it still has room. The rest are
 * asked about at the moment the choice is actually made, so a watcher left
 * running costs one account's traffic per interval rather than everyone's.
 */
async function watchTick(registry: RegistryManager, options: AutoOptions): Promise<TickReport> {
  const active = registry.getActiveAccount();
  if (!active) {
    return { event: 'idle', detail: 'no account in use', activeAccountId: null };
  }

  await refreshAndApply(registry, selectRefreshable([active]), options);

  const readActive = () => {
    const fresh = registry.getRegistry();
    const choice = chooseBestAccount(fresh.accounts, fresh.activeAccountId, Date.now());
    return {
      choice,
      current: choice.ranked.find((entry) => entry.account.id === fresh.activeAccountId),
    };
  };

  const { current } = readActive();
  if (current && current.score > 0) {
    return {
      event: 'holding',
      detail: `${formatAccountShort(active)} has ${percent(current.headroom)} of its 5-hour limit left`,
      activeAccountId: active.id,
    };
  }

  // The account in use is spent. Only now is a reading of the others worth its
  // traffic, and the choice must not be made on stale ones.
  const others = registry.getAccounts().filter((account) => account.id !== active.id);
  await refreshAndApply(registry, selectRefreshable(others), options);

  const { choice } = readActive();
  const reason = current?.blocked ?? 'out of quota';

  if (!choice.best) {
    return {
      event: 'exhausted',
      detail: `${formatAccountShort(active)}: ${reason}, and no other account can take work`,
      activeAccountId: active.id,
    };
  }

  const target = formatAccountShort(choice.best.account);
  if (options.dryRun) {
    return {
      event: 'would-switch',
      detail: `${formatAccountShort(active)}: ${reason}; would switch to ${target}`,
      activeAccountId: active.id,
      chosenAccountId: choice.best.account.id,
    };
  }

  try {
    Switcher.switchAccount(choice.best.account);
  } catch (error) {
    // The watcher outlives any one bad switch attempt - a stale keychain entry
    // or a lock held by another command is reported, not fatal.
    const message = error instanceof Error ? error.message : String(error);
    return {
      event: 'switch-failed',
      detail: `${formatAccountShort(active)}: ${reason}; could not switch to ${target} (${message})`,
      activeAccountId: active.id,
    };
  }

  return {
    event: 'switched',
    detail: `${formatAccountShort(active)}: ${reason}; switched to ${target}`,
    activeAccountId: choice.best.account.id,
    chosenAccountId: choice.best.account.id,
  };
}

function intervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INTERVAL_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new UsageError('`--interval` takes a number of minutes, at least 1.');
  }
  return minutes * 60_000;
}

/**
 * Watch the account in use and move off it when it runs out, until interrupted.
 *
 * This is a process you start and can see, not a service installed behind your
 * back: closing the terminal ends it.
 */
async function watchCommand(registry: RegistryManager, options: AutoOptions): Promise<void> {
  const period = intervalMs(options.interval);
  const controller = new AbortController();
  const onSigInt = () => controller.abort();
  process.once('SIGINT', onSigInt);

  if (!options.json) {
    const every = `${Math.round(period / 60_000)} min`;
    const action = options.dryRun ? 'reporting' : 'switching';
    console.log(
      `\n  Watching the account in use, ${action} when it runs out. Checking every ${every}.`
    );
    console.log(`  ${colors.dim('Ctrl-C to stop.')}\n`);
  }

  try {
    for (;;) {
      const report = await watchTick(registry, options);
      const nowMs = Date.now();

      if (options.json) {
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            command: 'auto',
            ok: report.event !== 'exhausted' && report.event !== 'switch-failed',
            data: { at: new Date(nowMs).toISOString(), ...report },
          })
        );
      } else {
        const line = `  ${colors.dim(clockOf(nowMs))}  ${report.detail}`;
        console.log(report.event === 'holding' ? colors.dim(line) : line);
      }

      await delay(period, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CancellationError('Stopped watching.');
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }
}

export async function autoCommand(options: AutoOptions = {}): Promise<void> {
  const registry = new RegistryManager();
  const accounts = registry.getAccounts();

  if (accounts.length === 0) {
    throw new UsageError('No accounts registered. Run `agy-auth login` to add an account.');
  }

  if (options.watch) {
    if (options.offline) {
      throw new UsageError(
        '`--watch` needs live readings and cannot be combined with `--offline`.'
      );
    }
    return watchCommand(registry, options);
  }

  if (!options.offline) {
    await refreshAndApply(registry, selectStale(accounts), options);
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
