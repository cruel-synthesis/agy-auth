import { Account, AccountStatus, AuthType, RateLimitWindow } from '../core/types.js';
import { colors, quotaColor } from './theme.js';

/** Said the same way wherever a command finds the registry empty. */
export const NO_ACCOUNTS =
  'No accounts yet. Run `agy-auth add` to save the account Antigravity is signed in to, or `agy-auth login` to sign in to another.';

export function formatAccountShort(account: Account): string {
  if (account.alias) {
    return `${account.alias} (${account.email})`;
  }
  return account.email;
}

export function formatAuthType(authType: AuthType): string {
  switch (authType) {
    case 'oauth':
      return 'OAuth';
    case 'api-key':
      return 'API Key';
    case 'service-account':
      return 'Service Account';
    case 'adc':
      return 'ADC';
    default:
      return authType;
  }
}

export function formatStatus(status: AccountStatus, isActive = false): string {
  switch (status) {
    case 'valid':
      return colors.green('valid');
    case 'rate-limited':
      return colors.yellow('rate-limited');
    case 'invalid':
      return colors.red('invalid');
    case 'expired':
      return colors.red('expired');
    case 'needs-reauth':
      return colors.yellow('needs-reauth');
    case 'unverified':
      return isActive ? 'unverified' : colors.dim('unverified');
    case 'unknown':
      return colors.yellow('unknown');
    default:
      return status;
  }
}

export function formatTimeAgo(timestamp?: number): string {
  if (!timestamp || timestamp <= 0) {
    return '-';
  }

  const now = Date.now();
  const diffMs = now - timestamp;
  if (diffMs < 0) return 'just now';

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) {
    return 'just now';
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${diffDays}d ago`;
}

/**
 * Short plan label for the PLAN column. Falls back to the authentication method
 * for accounts that have no subscription plan to report.
 */
export function formatPlan(account: Account): string {
  const plan = account.plan?.trim();
  if (plan) {
    const normalized = plan.toLowerCase();
    if (normalized.includes('ultra')) return 'Ultra';
    if (normalized.includes('pro')) return 'Pro';
    if (normalized.includes('premium')) return 'Premium';
    if (normalized.includes('enterprise')) return 'Enterprise';
    if (normalized.includes('free')) return 'Free';
    return plan.replace(/^Google AI /i, '').replace(/^Antigravity /i, '');
  }
  if (account.authType === 'api-key') return 'API Key';
  if (account.authType === 'service-account') return 'Service Acct';
  if (account.authType === 'adc') return 'ADC';
  return '-';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `6 Oct`, or `6 Oct 2025` outside the current year: one date style everywhere. */
export function formatDay(date: Date, nowMs: number = Date.now()): string {
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(nowMs).getFullYear()
    ? day
    : `${day} ${date.getFullYear()}`;
}

const METER_CELLS = 10;

/** A ten-cell bar for a remaining percentage, coloured by how much is left. */
export function quotaMeter(remaining: number): string {
  const filled = Math.round((remaining / 100) * METER_CELLS);
  return quotaColor(remaining)('━'.repeat(filled)) + colors.dim('─'.repeat(METER_CELLS - filled));
}

/**
 * Statuses that stop a quota reading from existing at all, and the compact word
 * for each. The caller shows this once beside the account; stamping it into
 * every quota column repeats one account-level fact four times and reads as
 * four separate expiries.
 */
export function blockingStatusLabel(status: AccountStatus | undefined): string | undefined {
  switch (status) {
    case 'rate-limited':
      return 'limited';
    case 'needs-reauth':
      return 'reauth';
    case 'expired':
      return 'expired';
    case 'invalid':
      return 'invalid';
    default:
      return undefined;
  }
}

export interface QuotaCell {
  /** Compact form for a table cell. */
  text: string;
  isError: boolean;
  state: 'unknown' | 'stale' | 'value';
  /** Remaining percentage, e.g. `35%`, present only when state is `value`. */
  percentText?: string;
  /** The same figure as a number, 0 to 100. */
  remaining?: number;
  /** Local reset instant, e.g. `14:30` or `1 Jan`, when the window reports one. */
  resetText?: string;
}

/**
 * Render one cached usage window.
 *
 * A window whose reset instant has passed is reported as `stale`, never as its
 * old percentage and never optimistically as `100%`: the cache says nothing
 * about usage after the reset, and only a live refresh can.
 */
export function formatQuotaCell(
  window: RateLimitWindow | undefined,
  nowMs: number = Date.now()
): QuotaCell {
  if (!window) return { text: '-', isError: false, state: 'unknown' };

  const remaining = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
  const percentText = `${remaining}%`;
  const isEmpty = remaining === 0;

  if (window.resetsAt === undefined) {
    return { text: percentText, isError: isEmpty, state: 'value', percentText, remaining };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec >= window.resetsAt) {
    return { text: 'stale', isError: false, state: 'stale' };
  }

  // Within a day the clock time says more than the date: a 5-hour window that
  // resets at 02:10 tonight is not usefully described as "tomorrow".
  const resetDate = new Date(window.resetsAt * 1000);
  const resetText =
    window.resetsAt - nowSec < 86_400
      ? `${String(resetDate.getHours()).padStart(2, '0')}:${String(resetDate.getMinutes()).padStart(2, '0')}`
      : formatDay(resetDate);

  return {
    text: `${percentText} (${resetText})`,
    isError: isEmpty,
    state: 'value',
    percentText,
    remaining,
    resetText,
  };
}

const DETAIL_LABEL_WIDTH = 14;

/** One `Label:  value` row of `current` and `details`, labels aligned and dimmed. */
export function detailLine(label: string, value: string): string {
  const key = `${label}:`;
  // Always leave at least one separating space, even for a full-width label.
  return `${colors.dim(key.padEnd(Math.max(DETAIL_LABEL_WIDTH, key.length + 1)))}${value}`;
}

/**
 * Plan and quota block shared by `current` and `details` so the two views can
 * never drift apart. Windows with no cached data render as `-`.
 */
export function quotaSummaryLines(account: Account, nowMs: number = Date.now()): string[] {
  const lines = [detailLine('Plan', account.plan?.trim() || formatPlan(account))];

  const windows: [string, RateLimitWindow | undefined][] = [
    ['Gemini 5h', account.rateLimit?.gemini?.rate5h],
    ['Gemini week', account.rateLimit?.gemini?.rateWeekly],
    ['Claude 5h', account.rateLimit?.claude?.rate5h],
    ['Claude week', account.rateLimit?.claude?.rateWeekly],
  ];

  for (const [label, window] of windows) {
    const cell = formatQuotaCell(window, nowMs);
    let value: string;
    switch (cell.state) {
      case 'unknown':
        value = colors.dim('-');
        break;
      case 'stale':
        value = colors.yellow('stale (window elapsed; refresh to update)');
        break;
      default: {
        const remaining = cell.remaining ?? 0;
        const percent = quotaColor(remaining)(`${cell.percentText} remaining`.padEnd(15));
        value = `${quotaMeter(remaining)}  ${percent}`;
        if (cell.resetText) value += colors.dim(`resets ${cell.resetText}`);
      }
    }
    lines.push(detailLine(label, value));
  }

  lines.push(
    detailLine(
      'Quota check',
      account.quotaCheckedAt ? formatTimeAgo(account.quotaCheckedAt) : 'never'
    )
  );

  return lines;
}
