import { setTimeout as delay } from 'node:timers/promises';
import {
  AccountScore,
  BLOCKED,
  BlockedReason,
  ChoiceBasis,
  MODEL_FAMILIES,
  chooseBestAccount,
} from '../core/best-account.js';
import { CancellationError, CliError, UsageError } from '../core/errors.js';
import { applyQuotaResults } from '../core/quota-apply.js';
import { QuotaOptions } from '../core/quota.js';
import { RegistryManager } from '../core/registry.js';
import { Switcher } from '../core/switcher.js';
import { Account, needsSignIn } from '../core/types.js';
import { NO_ACCOUNTS, formatAccountShort } from '../ui/format.js';
import { terminalWidth, truncatePadded, truncateToWidth } from '../ui/table.js';
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

/**
 * Which families the headroom figure speaks for, when it speaks for fewer than
 * all of them. A family that reported nothing is left out of the average, so
 * without this the reading of a single family is indistinguishable from a
 * reading of the whole account.
 */
function coverage(score: AccountScore): string {
  if (score.families.length === 0 || score.families.length === MODEL_FAMILIES.length) return '';
  return ` (${score.families.join(' and ')} only)`;
}

/** Below this the account name is clipped rather than squeezed any further. */
const MIN_RANKING_NAME_WIDTH = 10;

/** One line per account: what it has left, when it expires, and where it ranked. */
function renderRanking(
  ranked: AccountScore[],
  activeId: string | null,
  nowMs: number,
  basis: ChoiceBasis
): string[] {
  const rows = ranked.map((entry) => ({
    marker: entry.account.id === activeId ? '*' : ' ',
    name: formatAccountShort(entry.account),
    // No scored family means nothing was measured; 0% would claim otherwise.
    headroom: entry.perishing ? percent(entry.headroom) : '-',
    // An unread weekly window is scored as an untouched one; printing that
    // assumption as 100% would pass it off as a reading.
    weekly: entry.perishing?.measured ? percent(entry.perishing.remaining) : '-',
    expires: formatUntil(entry.perishing?.resetsAt, nowMs),
    // The score is only shown where it decided the order. On 5-hour headroom it
    // still holds an assumed week, and printing it beside a ranking it did not
    // produce would read as one that ignored its own numbers.
    note: entry.blocked ?? (basis === 'weekly' ? entry.score.toFixed(3) : ''),
  }));

  const width = (pick: (row: (typeof rows)[number]) => string, header: string) =>
    Math.max(header.length, ...rows.map((row) => pick(row).length));

  // Widest first is also most important first, so a terminal too narrow for the
  // whole line loses whole columns from the right rather than digits from a
  // number. The verdict printed below still names the winner either way.
  const columns = [
    { header: '5H', pick: (row: (typeof rows)[number]) => row.headroom },
    { header: 'WEEK', pick: (row: (typeof rows)[number]) => row.weekly },
    { header: 'EXPIRES', pick: (row: (typeof rows)[number]) => row.expires },
    {
      header: basis === 'weekly' ? 'SCORE' : 'NOTE',
      pick: (row: (typeof rows)[number]) => row.note,
    },
  ]
    .filter((column) => rows.some((row) => column.pick(row) !== ''))
    .map((column) => ({ ...column, width: width(column.pick, column.header) }));

  const termWidth = terminalWidth();
  const visible = [...columns];
  const restWidth = () => visible.reduce((sum, column) => sum + column.width + 2, 0);
  while (visible.length > 0 && 4 + MIN_RANKING_NAME_WIDTH + restWidth() > termWidth) {
    visible.pop();
  }

  const nameWidth = Math.max(
    MIN_RANKING_NAME_WIDTH,
    Math.min(
      width((row) => row.name, 'ACCOUNT'),
      termWidth - 4 - restWidth()
    )
  );

  // Trimmed so that no line carries the padding of its last cell.
  const cells = (name: string, pick: (column: (typeof visible)[number]) => string): string =>
    [truncatePadded(name, nameWidth), ...visible.map(pick)].join('  ').trimEnd();

  // Clipped before it is dimmed: clipping counts characters, and would count
  // the escape codes as text and cut off the one that ends the style.
  const header = colors.dim(
    truncateToWidth(
      `    ${cells('ACCOUNT', (column) => column.header.padEnd(column.width))}`,
      termWidth,
      ''
    )
  );

  return [
    header,
    ...rows.map((row) => {
      const line = cells(row.name, (column) => column.pick(row).padEnd(column.width));
      return truncateToWidth(`  ${row.marker} ${line}`, termWidth, '');
    }),
  ];
}

/** Warning lines as the human output shows them. */
function printWarnings(lines: string[]): void {
  for (const line of lines) {
    console.error(colors.yellow(`  ${line.startsWith('Warning') ? line : `Warning: ${line}`}`));
  }
}

const CHECK_HINT = 'Run `agy-auth list --check` for a live reading.';
const SIGN_IN_HINT = 'Sign in through Antigravity, then run `agy-auth add`.';

/**
 * Why no account can take work, in terms of what is actually known.
 *
 * An account that was never read is not one known to be spent, and one that
 * needs a sign-in or is not OAuth was never going to be read, so each is named
 * for what it is rather than counted as out of quota or as unread.
 */
function refusal(ranked: AccountScore[], nowMs: number): string {
  const count = (...reasons: BlockedReason[]) =>
    ranked.filter((entry) => entry.blocked !== undefined && reasons.includes(entry.blocked)).length;
  const fiveHour = count(BLOCKED.fiveHour);
  const weekly = count(BLOCKED.weekly);
  const spent = fiveHour + weekly;
  const unread = count(BLOCKED.unread);
  const signIn = count(BLOCKED.signIn);
  const notOauth = count(BLOCKED.notOauth);

  const soonest = ranked
    .filter((entry) => entry.blocked === BLOCKED.fiveHour || entry.blocked === BLOCKED.weekly)
    .map((entry) => entry.refillsAt)
    .filter((at): at is number => at !== undefined)
    .sort((a, b) => a - b)[0];
  const frees = soonest !== undefined ? formatUntil(soonest, nowMs) : undefined;

  if (spent === ranked.length) {
    const limit = weekly === 0 ? '5-hour ' : fiveHour === 0 ? 'weekly ' : '';
    return `Every account is out of ${limit}quota. ${frees ? `The first frees up in ${frees}.` : CHECK_HINT}`;
  }
  if (unread === ranked.length) {
    return `Quota could not be determined for any account. ${CHECK_HINT}`;
  }
  if (signIn === ranked.length) {
    return `Every account needs a fresh sign-in. ${SIGN_IN_HINT}`;
  }
  if (notOauth === ranked.length) {
    return 'Only OAuth accounts can be chosen automatically, and none is saved.';
  }

  const parts = [
    spent > 0 ? `${spent} out of quota` : '',
    unread > 0 ? `${unread} not read` : '',
    signIn > 0 ? `${signIn} needing a fresh sign-in` : '',
    notOauth > 0 ? `${notOauth} not OAuth` : '',
  ].filter(Boolean);
  return [
    `No account has known usable quota: ${parts.join(', ')}.`,
    frees ? `Of those out of quota, the first frees up in ${frees}.` : '',
    unread > 0 ? CHECK_HINT : '',
    signIn > 0 ? SIGN_IN_HINT : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Why the winner won, in the terms that decided it. */
function explain(best: AccountScore, nowMs: number, basis: ChoiceBasis): string {
  const weekly = best.perishing;
  if (basis === 'headroom' || !weekly || weekly.resetsAt === undefined) {
    return `It has the most room to work: ${percent(best.headroom)} of the 5-hour limit left${coverage(best)}.`;
  }
  return (
    `${percent(weekly.remaining)} of its weekly limit is unspent and expires in ` +
    `${formatUntil(weekly.resetsAt, nowMs)} - the quota most likely to go to waste.`
  );
}

interface RefreshOutcome {
  /** One-line human warning, present only when a refresh failed. */
  warning?: string;
  /** Ids of accounts whose refresh did not succeed this call. */
  failed: Set<string>;
}

/** Take a live reading for these accounts and write it to the registry. */
async function refreshAndApply(
  registry: RegistryManager,
  accounts: Account[],
  options: AutoOptions
): Promise<RefreshOutcome> {
  const refresh = await refreshQuota(accounts, false, options.quotaOptions);
  await applyQuotaResults(registry, refresh.refreshes);
  return {
    warning: refresh.warning,
    failed: new Set(refresh.refreshes.filter((r) => !r.result.ok).map((r) => r.result.accountId)),
  };
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
  if (active.authType !== 'oauth') {
    // Only OAuth accounts report quota, so this one can never be seen to run out.
    // Scoring it as spent would move off an account chosen on purpose.
    return {
      event: 'idle',
      detail: `${formatAccountShort(active)} is not an OAuth account, so it has no quota to watch`,
      activeAccountId: active.id,
    };
  }

  const activeRefresh = await refreshAndApply(registry, selectRefreshable([active]), options);
  const afterRefresh = registry.getActiveAccount();
  const signInNeeded = afterRefresh !== null && needsSignIn(afterRefresh);
  if (activeRefresh.failed.has(active.id) && !signInNeeded) {
    // A failed reading is not a reading. Deciding "exhausted" from it would act
    // on data no fresher than what was already on hand, and could switch away
    // from an account that still has quota simply because the network didn't.
    // A rejected credential is the exception: that answer is decisive, and
    // holding on it would wait for a token that cannot come back on its own.
    return {
      event: 'holding',
      detail: `${formatAccountShort(active)}: ${activeRefresh.warning ?? 'could not refresh quota this check'}; using the last known reading`,
      activeAccountId: active.id,
    };
  }

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
      detail: `${formatAccountShort(active)} has ${percent(current.headroom)} of its 5-hour limit left${coverage(current)}`,
      activeAccountId: active.id,
    };
  }

  if (current?.blocked === BLOCKED.unread) {
    // The reading came back without a current 5-hour window, which says nothing
    // about whether the account ran out. Moving on it would act on no evidence.
    return {
      event: 'holding',
      detail: `${formatAccountShort(active)}: ${BLOCKED.unread}; staying until one comes back`,
      activeAccountId: active.id,
    };
  }

  // The account in use is spent. Only now is a reading of the others worth its
  // traffic, and the choice must not be made on stale ones. An account already
  // known to need a sign-in cannot be chosen, and asking about it again would
  // only attach its failure to every decision.
  const others = registry
    .getAccounts()
    .filter((account) => account.id !== active.id && !needsSignIn(account));
  const othersRefresh = await refreshAndApply(registry, selectRefreshable(others), options);

  const { choice } = readActive();
  const reason = current?.blocked ?? 'out of quota';
  // Whoever is chosen next may be chosen on a reading that could not be
  // renewed, so the failure travels with the decision rather than being dropped.
  const stale = othersRefresh.warning ? ` - ${othersRefresh.warning}` : '';

  if (!choice.best) {
    return {
      event: 'exhausted',
      detail: `${formatAccountShort(active)}: ${reason}, and no other account has known usable quota${stale}`,
      activeAccountId: active.id,
    };
  }

  const target = formatAccountShort(choice.best.account);
  if (options.dryRun) {
    return {
      event: 'would-switch',
      detail: `${formatAccountShort(active)}: ${reason}; would switch to ${target}${stale}`,
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
      detail: `${formatAccountShort(active)}: ${reason}; could not switch to ${target} (${message})${stale}`,
      activeAccountId: active.id,
    };
  }

  return {
    event: 'switched',
    detail: `${formatAccountShort(active)}: ${reason}; switched to ${target}${stale}`,
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
    throw new CliError(NO_ACCOUNTS, 'no_accounts');
  }

  if (options.watch) {
    if (options.offline) {
      throw new UsageError(
        '`--watch` needs live readings and cannot be combined with `--offline`.'
      );
    }
    return watchCommand(registry, options);
  }

  let warning: string | undefined;
  if (!options.offline) {
    warning = (await refreshAndApply(registry, selectStale(accounts), options)).warning;
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
    for (const line of renderRanking(choice.ranked, activeId, nowMs, choice.basis)) {
      console.log(line);
    }
    if (choice.best && choice.basis === 'headroom') {
      console.log(colors.dim('  Ranked on measured 5-hour headroom: a weekly window went unread.'));
    }
    console.log('');
  }

  // A reading that could not be renewed is part of the verdict, including a
  // verdict of none: whatever is reported was decided on what was already on
  // hand.
  const refreshWarnings = warning ? [warning] : [];

  if (!choice.best) {
    if (!options.json) {
      printWarnings(refreshWarnings);
    }
    throw new CliError(
      refusal(choice.ranked, nowMs),
      'cli_error',
      1,
      refreshWarnings.length > 0 ? { warnings: refreshWarnings } : {}
    );
  }

  const switched = choice.shouldSwitch && !options.dryRun;
  const result = switched ? Switcher.switchAccount(choice.best.account) : undefined;
  const warnings = [...refreshWarnings, ...(result?.warnings ?? [])];

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
            basis: choice.basis,
            ranking: choice.ranked.map((entry) => ({
              accountId: entry.account.id,
              email: entry.account.email,
              score: entry.score,
              headroom: entry.headroom,
              weeklyRemaining: entry.perishing?.measured ? entry.perishing.remaining : undefined,
              weeklyResetsAt: entry.perishing?.resetsAt,
              blocked: entry.blocked,
            })),
            warnings: warnings.length ? warnings : undefined,
          },
        },
        null,
        2
      )
    );
    return;
  }

  printWarnings(warnings);

  // Staying means staying on the account in use, which is not always the one
  // that ranked first: a lead inside the margin is not enough to move.
  const staying = choice.ranked.find((entry) => entry.account.id === activeId);
  const subject = choice.shouldSwitch ? choice.best : (staying ?? choice.best);
  const name = colors.green(formatAccountShort(subject.account));
  const verdict = switched
    ? `Switched to ${name}`
    : choice.shouldSwitch
      ? `Would switch to ${name}`
      : subject === choice.best
        ? `Staying on ${name} - already the best use of your quota.`
        : `Staying on ${name}.`;
  // The reasons belong to whichever account ranked first. Giving them to the
  // one kept in use would contradict the ranking printed just above.
  const reason =
    subject === choice.best
      ? explain(subject, nowMs, choice.basis)
      : `${formatAccountShort(choice.best.account)} ranks first, but not by enough to be worth rewriting the session.`;

  console.log(`  ${verdict}`);
  console.log(`  ${colors.dim(reason)}\n`);
}
