import {
  Account,
  ModelRateLimits,
  RateLimitWindow,
  WINDOW_MINUTES_5H,
  WINDOW_MINUTES_WEEKLY,
  needsSignIn,
} from './types.js';

/** One 5-hour window: the unit the weekly allowance is necessarily spent in. */
const FIVE_HOURS_MS = WINDOW_MINUTES_5H * 60_000;

/** Assumed when a weekly window reports no reset instant. */
const ONE_WEEK_MS = WINDOW_MINUTES_WEEKLY * 60_000;

/**
 * Below this share of the 5-hour allowance an account cannot carry a working
 * stint, so it is not worth moving to however urgent its weekly allowance is.
 */
const MIN_HEADROOM = 0.1;

/**
 * How much better a candidate must be before it displaces the account in use.
 * A switch rewrites the Antigravity session, so a hair's-breadth lead is not
 * worth the churn.
 */
const SWITCH_MARGIN = 0.05;

/** Why an account is out of the running, as the ranking prints it. */
export const BLOCKED = {
  notOauth: 'not an OAuth account',
  signIn: 'needs a fresh sign-in',
  unread: 'no current quota reading',
  fiveHour: '5-hour limit nearly spent',
  weekly: 'weekly limit nearly spent',
} as const;
export type BlockedReason = (typeof BLOCKED)[keyof typeof BLOCKED];

/** The model families a reading can cover. */
export const MODEL_FAMILIES = ['gemini', 'claude'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** The weekly allowance nearest to expiring, and what it is worth. */
export interface PerishingWeekly {
  family: ModelFamily;
  /** Share of the weekly allowance still unspent, 0 to 1. */
  remaining: number;
  /**
   * False when the window reported nothing and `remaining` is the untouched
   * week the score assumes in its place. Callers that show the figure must not
   * present that assumption as a reading.
   */
  measured: boolean;
  /** Epoch seconds at which it resets, when the window reports one. */
  resetsAt?: number;
}

/**
 * Whether every contributing family reported a weekly window, none did, or the
 * score mixes the two.
 */
export type WeeklyBasis = 'measured' | 'mixed' | 'assumed';

export interface AccountScore {
  account: Account;
  /**
   * Expected value of working on this account now. Higher is better; zero means
   * it cannot serve work at all.
   */
  score: number;
  /** Mean share of the 5-hour allowance left across the families with a reading. */
  headroom: number;
  /**
   * The families `headroom` was actually averaged over. Shorter than
   * `MODEL_FAMILIES` when a family reported nothing, in which case the figure
   * describes only part of the account.
   */
  families: ModelFamily[];
  /** The allowance that argues loudest for choosing this account. */
  perishing?: PerishingWeekly;
  /**
   * How much of the weekly input behind `score` came from readings rather than
   * from the untouched week assumed in a missing window's place. `perishing`
   * speaks for one family only, so it cannot answer this for the whole score.
   */
  weeklyBasis: WeeklyBasis;
  /**
   * Mean share of the weekly allowance left across the families that reported
   * one, and the soonest of their resets. Absent when no weekly window was read.
   */
  measuredWeek?: { remaining: number; resetsAt?: number };
  /** Epoch seconds at which the account can next take work, when a reading says. */
  refillsAt?: number;
  /** Why the account is out of the running, when it is. */
  blocked?: BlockedReason;
}

/**
 * What the ranking and the choice were decided on.
 *
 * `weekly` means every account that can take work reported every weekly window,
 * so the full score - the quota most likely to be wasted - ordered them.
 * `headroom` means at least one did not, so the weekly term was set aside and
 * the measured 5-hour headroom decided on its own.
 */
export type ChoiceBasis = 'weekly' | 'headroom';

export interface BestAccountChoice {
  /** Every account considered, best first on `basis`. */
  ranked: AccountScore[];
  /** The account to work on, or null when none can serve work. */
  best: AccountScore | null;
  /** True when `best` is not the account already in use. */
  shouldSwitch: boolean;
  /** The figure `ranked` was ordered on and `best` was chosen by. */
  basis: ChoiceBasis;
}

/**
 * Share of an allowance still unspent, or undefined when the cache cannot say.
 *
 * A window whose reset has passed is not reported as full: the cache knows
 * nothing about usage since that instant, and guessing would hand work to an
 * account that may have none left.
 */
function remaining(window: RateLimitWindow | undefined, nowMs: number): number | undefined {
  if (!window) return undefined;
  if (window.resetsAt !== undefined && nowMs / 1000 >= window.resetsAt) return undefined;
  return Math.max(0, Math.min(1, (100 - window.usedPercent) / 100));
}

interface FamilyScore {
  headroom: number;
  value: number;
  weekly: PerishingWeekly;
  refillsAt?: number;
}

/**
 * Score one model family.
 *
 * Two things decide whether working here now is a good use of the account. The
 * 5-hour allowance sets how much work it can take before the next reset. The
 * weekly allowance sets how much is at stake: divided by the number of 5-hour
 * windows left before it resets, it gives the share that has to be spent per
 * window for none of it to be lost. That pressure rises as the reset closes in,
 * which is what makes a smaller allowance expiring tomorrow outrank a larger one
 * expiring next week - the later one can still be spent later, the sooner one
 * cannot.
 *
 * Both terms are fractions of their own allowance rather than absolute tokens,
 * which is all the service reports. The ratio between a weekly and a 5-hour
 * allowance is unknown but the same for every account on a plan, so it cancels
 * out of the comparison.
 */
function scoreFamily(
  family: ModelFamily,
  limits: ModelRateLimits | undefined,
  nowMs: number
): FamilyScore | undefined {
  const headroom = remaining(limits?.rate5h, nowMs);
  if (headroom === undefined) return undefined;

  // No usable weekly reading: assume an ordinary untouched week, which ranks the
  // family below anything visibly about to expire and above anything visibly
  // spent. The stale window's own reset instant is discarded along with its
  // share - keeping it would read an elapsed deadline as maximum urgency.
  const weeklyRead = remaining(limits?.rateWeekly, nowMs);
  const resetsAt = weeklyRead === undefined ? undefined : limits?.rateWeekly?.resetsAt;
  const weeklyRemaining = weeklyRead ?? 1;
  const msLeft = resetsAt !== undefined ? resetsAt * 1000 - nowMs : ONE_WEEK_MS;
  const windowsLeft = Math.max(1, Math.ceil(msLeft / FIVE_HOURS_MS));

  // A spent week keeps the family out past its next 5-hour reset, so that reset
  // is not when it can work again.
  const refillsAt = weeklyRead === 0 ? resetsAt : limits?.rate5h?.resetsAt;

  return {
    headroom,
    value: headroom * (weeklyRemaining / windowsLeft),
    ...(refillsAt !== undefined ? { refillsAt } : {}),
    weekly: {
      family,
      remaining: weeklyRemaining,
      measured: weeklyRead !== undefined,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    },
  };
}

/** How soon this weekly allowance expires; earlier sorts first. */
function expiresAt(weekly: PerishingWeekly): number {
  return weekly.resetsAt ?? Number.POSITIVE_INFINITY;
}

function scoreAccount(account: Account, nowMs: number): AccountScore {
  const base = {
    account,
    score: 0,
    headroom: 0,
    families: [] as ModelFamily[],
    weeklyBasis: 'assumed' as WeeklyBasis,
  };

  if (account.authType !== 'oauth') {
    return { ...base, blocked: BLOCKED.notOauth };
  }
  if (needsSignIn(account)) {
    return { ...base, blocked: BLOCKED.signIn };
  }

  const scored = MODEL_FAMILIES.map((family) =>
    scoreFamily(family, account.rateLimit?.[family], nowMs)
  ).filter((entry): entry is FamilyScore => entry !== undefined);

  if (scored.length === 0) {
    return { ...base, blocked: BLOCKED.unread };
  }

  const headroom = scored.reduce((sum, s) => sum + s.headroom, 0) / scored.length;
  // The allowance with the most to lose soonest is the one worth explaining. On
  // a tie a reading beats the untouched week assumed in a missing one's place.
  const perishing = scored.reduce((worst, s) => {
    const at = expiresAt(s.weekly);
    const worstAt = expiresAt(worst.weekly);
    return at < worstAt || (at === worstAt && s.weekly.measured && !worst.weekly.measured)
      ? s
      : worst;
  }).weekly;
  const refills = scored.map((s) => s.refillsAt).filter((at): at is number => at !== undefined);
  const weeks = scored.filter((s) => s.weekly.measured).map((s) => s.weekly);
  const weekResets = weeks.map((w) => w.resetsAt).filter((at): at is number => at !== undefined);
  const measured = weeks.length;
  const common = {
    headroom,
    families: scored.map((s) => s.weekly.family),
    perishing,
    weeklyBasis: (measured === scored.length
      ? 'measured'
      : measured === 0
        ? 'assumed'
        : 'mixed') as WeeklyBasis,
    ...(weeks.length > 0
      ? {
          measuredWeek: {
            remaining: weeks.reduce((sum, w) => sum + w.remaining, 0) / weeks.length,
            ...(weekResets.length > 0 ? { resetsAt: Math.min(...weekResets) } : {}),
          },
        }
      : {}),
    ...(refills.length > 0 ? { refillsAt: Math.min(...refills) } : {}),
  };

  const score = scored.reduce((sum, s) => sum + s.value, 0) / scored.length;
  // Every week spent, or every family with 5-hour room has a spent week: a
  // 5-hour reset would not free it, so it is held by the week, not the window.
  const weekSpent = scored.every((s) => s.weekly.measured && s.weekly.remaining === 0);
  if (weekSpent || (score === 0 && headroom >= MIN_HEADROOM)) {
    return { ...base, ...common, blocked: BLOCKED.weekly };
  }
  if (headroom < MIN_HEADROOM) {
    return { ...base, ...common, blocked: BLOCKED.fiveHour };
  }

  return { account, score, ...common };
}

/**
 * Takes an account out of the running because its measured week is all but
 * spent. It frees up when that week resets, not when its 5-hour window does.
 */
function holdOutForWeek(entry: AccountScore): AccountScore {
  const { refillsAt: _fiveHourReset, ...rest } = entry;
  const resetsAt = entry.measuredWeek?.resetsAt;
  return {
    ...rest,
    score: 0,
    blocked: BLOCKED.weekly,
    ...(resetsAt !== undefined ? { refillsAt: resetsAt } : {}),
  };
}

/**
 * Best first on `basis`, with everything that cannot take work last and ties
 * settled the same way on every run.
 *
 * On `headroom` the weekly figures are left out of the ordering entirely,
 * including as a tiebreaker: an account that reported no weekly window has no
 * reset instant to be sorted by, so using one would let a missing reading
 * settle the order.
 */
function byBasis(basis: ChoiceBasis): (a: AccountScore, b: AccountScore) => number {
  const workable = (entry: AccountScore) => (entry.score > 0 ? 1 : 0);
  return (a, b) => {
    if (workable(a) !== workable(b)) return workable(b) - workable(a);

    if (basis === 'weekly') {
      if (a.score !== b.score) return b.score - a.score;
      if (a.headroom !== b.headroom) return b.headroom - a.headroom;

      const aExpiry = a.perishing ? expiresAt(a.perishing) : Number.POSITIVE_INFINITY;
      const bExpiry = b.perishing ? expiresAt(b.perishing) : Number.POSITIVE_INFINITY;
      if (aExpiry !== bExpiry) return aExpiry - bExpiry;
    } else if (a.headroom !== b.headroom) {
      return b.headroom - a.headroom;
    }

    return a.account.id.localeCompare(b.account.id);
  };
}

/**
 * Rank accounts by how well working on each one now spends quota that would
 * otherwise go to waste, and say whether moving off the active account is worth
 * it.
 *
 * An unread weekly window is scored as an untouched one, which is a placeholder
 * and not a reading. That placeholder may not pick where the session goes, so
 * the weekly term orders the accounts only when every account that can take
 * work reported every weekly window. Short of that the choice drops to the one
 * figure all of them did measure, their 5-hour headroom, and the same figure
 * decides the ranking, the destination and the margin the account in use has to
 * be beaten by. Because that figure says nothing about the week, an account whose
 * measured week is all but spent is left out of it. An account that cannot take
 * work at all is not a comparison: anything that can beats it.
 */
export function chooseBestAccount(
  accounts: Account[],
  activeAccountId: string | null,
  nowMs: number = Date.now()
): BestAccountChoice {
  const all = accounts.map((account) => scoreAccount(account, nowMs));
  const basis: ChoiceBasis =
    all.some((entry) => entry.score > 0) &&
    all.every((entry) => entry.score === 0 || entry.weeklyBasis === 'measured')
      ? 'weekly'
      : 'headroom';

  // On headroom the weekly allowance is not weighed at all, so an account whose
  // measured week is all but spent would rank on 5-hour room it cannot use. The
  // weekly score needs no such rule: it already prices a small week by how soon
  // it resets, which is what makes burning the last of one before it goes worth it.
  const scored =
    basis === 'weekly'
      ? all
      : all.map((entry) =>
          entry.score > 0 &&
          entry.measuredWeek !== undefined &&
          entry.measuredWeek.remaining < MIN_HEADROOM
            ? holdOutForWeek(entry)
            : entry
        );
  const candidates = scored.filter((entry) => entry.score > 0);

  const ranked = scored.sort(byBasis(basis));
  const value = (entry: AccountScore) => (basis === 'weekly' ? entry.score : entry.headroom);

  // Sorted with the unworkable last, so the first entry is a candidate whenever
  // there is one: a top-ranked account that cannot be moved to never stands in
  // front of one that can.
  const best = candidates.length > 0 ? ranked[0] : null;
  const active = ranked.find((entry) => entry.account.id === activeAccountId);
  const activeValue = active && active.score > 0 ? value(active) : 0;

  return {
    ranked,
    best,
    shouldSwitch:
      best !== null &&
      best.account.id !== activeAccountId &&
      value(best) > activeValue * (1 + SWITCH_MARGIN),
    basis,
  };
}
