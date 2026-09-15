import {
  Account,
  ModelRateLimits,
  RateLimitWindow,
  WINDOW_MINUTES_5H,
  WINDOW_MINUTES_WEEKLY,
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

/** The model families a reading can cover. */
export const MODEL_FAMILIES = ['gemini', 'claude'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** Statuses that make an account unusable until the user signs in again. */
const NEEDS_USER_ACTION: ReadonlySet<string> = new Set(['expired', 'invalid', 'needs-reauth']);

/** The weekly allowance nearest to expiring, and what it is worth. */
export interface PerishingWeekly {
  family: ModelFamily;
  /** Share of the weekly allowance still unspent, 0 to 1. */
  remaining: number;
  /** Epoch seconds at which it resets, when the window reports one. */
  resetsAt?: number;
}

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
  /** Epoch seconds at which the soonest 5-hour allowance refills, when known. */
  refillsAt?: number;
  /** Why the account is out of the running, when it is. */
  blocked?: string;
}

export interface BestAccountChoice {
  /** Every account considered, best first. */
  ranked: AccountScore[];
  /** The account to work on, or null when none can serve work. */
  best: AccountScore | null;
  /** True when `best` is not the account already in use. */
  shouldSwitch: boolean;
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

  return {
    headroom,
    value: headroom * (weeklyRemaining / windowsLeft),
    ...(limits?.rate5h?.resetsAt !== undefined ? { refillsAt: limits.rate5h.resetsAt } : {}),
    weekly: {
      family,
      remaining: weeklyRemaining,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    },
  };
}

/** How soon this weekly allowance expires; earlier sorts first. */
function expiresAt(weekly: PerishingWeekly): number {
  return weekly.resetsAt ?? Number.POSITIVE_INFINITY;
}

function scoreAccount(account: Account, nowMs: number): AccountScore {
  const base = { account, score: 0, headroom: 0, families: [] as ModelFamily[] };

  if (account.authType !== 'oauth') {
    return { ...base, blocked: 'not an OAuth account' };
  }
  if (NEEDS_USER_ACTION.has(account.status)) {
    return { ...base, blocked: 'needs a fresh sign-in' };
  }

  const scored = MODEL_FAMILIES.map((family) =>
    scoreFamily(family, account.rateLimit?.[family], nowMs)
  ).filter((entry): entry is FamilyScore => entry !== undefined);

  if (scored.length === 0) {
    return { ...base, blocked: 'no current quota reading' };
  }

  const headroom = scored.reduce((sum, s) => sum + s.headroom, 0) / scored.length;
  // The allowance with the most to lose soonest is the one worth explaining.
  const perishing = scored.reduce((worst, s) =>
    expiresAt(s.weekly) < expiresAt(worst.weekly) ? s : worst
  ).weekly;
  const refills = scored.map((s) => s.refillsAt).filter((at): at is number => at !== undefined);
  const common = {
    headroom,
    families: scored.map((s) => s.weekly.family),
    perishing,
    ...(refills.length > 0 ? { refillsAt: Math.min(...refills) } : {}),
  };

  if (headroom < MIN_HEADROOM) {
    return { ...base, ...common, blocked: '5-hour limit nearly spent' };
  }

  return {
    account,
    score: scored.reduce((sum, s) => sum + s.value, 0) / scored.length,
    ...common,
  };
}

/** Best first, with ties settled the same way on every run. */
function byValue(a: AccountScore, b: AccountScore): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.headroom !== b.headroom) return b.headroom - a.headroom;

  const aExpiry = a.perishing ? expiresAt(a.perishing) : Number.POSITIVE_INFINITY;
  const bExpiry = b.perishing ? expiresAt(b.perishing) : Number.POSITIVE_INFINITY;
  if (aExpiry !== bExpiry) return aExpiry - bExpiry;

  return a.account.id.localeCompare(b.account.id);
}

/**
 * Rank accounts by how well working on each one now spends quota that would
 * otherwise go to waste, and say whether moving off the active account is worth
 * it.
 */
export function chooseBestAccount(
  accounts: Account[],
  activeAccountId: string | null,
  nowMs: number = Date.now()
): BestAccountChoice {
  const ranked = accounts.map((account) => scoreAccount(account, nowMs)).sort(byValue);

  const best = ranked.length > 0 && ranked[0].score > 0 ? ranked[0] : null;
  const active = ranked.find((entry) => entry.account.id === activeAccountId);

  return {
    ranked,
    best,
    shouldSwitch:
      best !== null &&
      best.account.id !== activeAccountId &&
      best.score > (active?.score ?? 0) * (1 + SWITCH_MARGIN),
  };
}
