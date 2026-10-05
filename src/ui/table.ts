import stringWidth from 'string-width';
import { Account, needsSignIn } from '../core/types.js';
import {
  NO_ACCOUNTS,
  QuotaCell,
  blockingStatusLabel,
  formatPlan,
  formatQuotaCell,
  formatTimeAgo,
} from './format.js';
import { colors, quotaColor } from './theme.js';

export function pad(str: string, targetWidth: number): string {
  const currentWidth = stringWidth(str);
  if (currentWidth >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - currentWidth);
}

/**
 * Grapheme-aware visual display width truncation.
 * Never exceeds targetWidth regardless of multi-byte or CJK full-width characters.
 */
export function truncateToWidth(str: string, targetWidth: number, ellipsis = '.'): string {
  const currentWidth = stringWidth(str);
  if (currentWidth <= targetWidth) return str;
  if (targetWidth <= 0) return '';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const segments = (value: string): string[] =>
    Array.from(segmenter.segment(value), (entry) => entry.segment);
  const takeWidth = (value: string, width: number): string => {
    let used = 0;
    let result = '';
    for (const segment of segments(value)) {
      const segmentWidth = stringWidth(segment);
      if (used + segmentWidth > width) break;
      used += segmentWidth;
      result += segment;
    }
    return result;
  };

  let safeEllipsis = ellipsis;
  if (stringWidth(safeEllipsis) > targetWidth) {
    safeEllipsis = takeWidth(safeEllipsis, targetWidth);
  }
  const ellipsisWidth = stringWidth(safeEllipsis);
  const maxContentWidth = Math.max(0, targetWidth - ellipsisWidth);

  return takeWidth(str, maxContentWidth) + safeEllipsis;
}

export function truncateAccount(str: string, maxWidth: number): string {
  return truncateToWidth(str, maxWidth, '.');
}

export function truncatePadded(str: string, width: number): string {
  if (width <= 0) return '';
  const truncated = truncateToWidth(str, width, '.');
  return pad(truncated, width);
}

export interface TableRowComponent {
  account: Account;
  index: number;
  isActive: boolean;
  marker: string;
  choiceText: string;
  coloredText: string;
}

export interface TableComponents {
  headerLine: string;
  dividerLine: string;
  rows: TableRowComponent[];
}

type QuotaColumnKey = 'gemini5h' | 'geminiWk' | 'claude5h' | 'claudeWk';
type ColumnKey = 'plan' | QuotaColumnKey | 'last';

/** Everything a table cell needs: rendered text plus whether to flag it. */
type Cell = { text: string; isError: boolean } | QuotaCell;

/**
 * Colours one padded cell. A quota reading is coloured by how much is left,
 * with its reset time dimmed so the percentage is what the eye lands on.
 */
function colorCell(key: ColumnKey, cell: Cell, padded: string, isActive: boolean): string {
  if (!padded.startsWith(cell.text)) return cell.isError ? colors.red(padded) : padded;
  const rest = padded.slice(cell.text.length);
  if ('state' in cell) {
    if (cell.state === 'stale') return colors.yellow(cell.text) + rest;
    if (cell.state === 'unknown' || cell.remaining === undefined)
      return colors.dim(cell.text) + rest;
    const reset = cell.resetText ? ` ${colors.dim(`(${cell.resetText})`)}` : '';
    return quotaColor(cell.remaining)(cell.percentText ?? cell.text) + reset + rest;
  }
  if (cell.isError) return colors.red(padded);
  if (key === 'last' && !isActive) return colors.dim(padded);
  return padded;
}

/** The account label with its email dimmed beside an alias; the active one in bold green. */
function colorAccount(account: Account, padded: string, isActive: boolean): string {
  if (isActive) return colors.bold(colors.green(padded));
  const alias = account.alias;
  if (!alias || !padded.startsWith(`${alias} `)) return padded;
  return alias + colors.dim(padded.slice(alias.length));
}

const COLUMN_HEADERS: Record<ColumnKey, string> = {
  plan: 'PLAN',
  gemini5h: 'GEMINI 5H',
  geminiWk: 'GEMINI WK',
  claude5h: 'CLAUDE 5H',
  claudeWk: 'CLAUDE WK',
  last: 'LAST',
};

/**
 * Least important column first. Retention priority is therefore ACCOUNT, PLAN,
 * GEMINI 5H, CLAUDE 5H, the weekly columns, then LAST.
 */
const COLUMN_DROP_ORDER: ColumnKey[] = [
  'last',
  'claudeWk',
  'geminiWk',
  'claude5h',
  'gemini5h',
  'plan',
];

const MIN_ACCOUNT_WIDTH = 10;
const MAX_PLAN_WIDTH = 20;
const COLUMN_SEPARATOR_WIDTH = 2;
/** Below this the table degrades to account names only. */
const NARROW_FALLBACK_WIDTH = 24;

/**
 * The width to render into: an explicit override, the live TTY, then `$COLUMNS`,
 * then a conventional 120 when nothing says otherwise.
 */
export function terminalWidth(override?: number): number {
  if (override) return override;
  const envColumns = Number.parseInt(process.env.COLUMNS || '', 10);
  const fallbackWidth = Number.isFinite(envColumns) && envColumns > 0 ? envColumns : 120;
  return process.stdout.isTTY ? process.stdout.columns || fallbackWidth : fallbackWidth;
}

function quotaWindow(account: Account, key: QuotaColumnKey) {
  switch (key) {
    case 'gemini5h':
      return account.rateLimit?.gemini?.rate5h;
    case 'geminiWk':
      return account.rateLimit?.gemini?.rateWeekly;
    case 'claude5h':
      return account.rateLimit?.claude?.rate5h;
    case 'claudeWk':
      return account.rateLimit?.claude?.rateWeekly;
  }
}

export function getTableComponents(
  accounts: Account[],
  activeAccountId: string | null,
  maxWidthOverride?: number
): TableComponents {
  const termWidth = terminalWidth(maxWidthOverride);
  const idxWidth = Math.max(2, String(accounts.length).length);
  const nowMs = Date.now();

  // Fallback for extremely narrow terminals
  if (termWidth < NARROW_FALLBACK_WIDTH) {
    const prefixWidth = 2 + idxWidth + 1;
    const headerLine = truncateToWidth(
      colors.cyan(`${' '.repeat(prefixWidth)}ACCOUNT`),
      termWidth,
      ''
    );
    const dividerLine = truncateToWidth(colors.dim('-'.repeat(termWidth)), termWidth, '');
    const rows: TableRowComponent[] = accounts.map((acc, idx) => {
      const isActive = acc.id === activeAccountId;
      const marker = isActive ? '* ' : '  ';
      const num = String(idx + 1).padStart(idxWidth, '0');
      const label = acc.alias || acc.email;
      const uncolored = truncateToWidth(`${marker}${num} ${label}`, termWidth, '');
      const colored = isActive ? colors.green(uncolored) : uncolored;
      return {
        account: acc,
        index: idx,
        isActive,
        marker,
        choiceText: uncolored,
        coloredText: colored,
      };
    });
    return { headerLine, dividerLine, rows };
  }

  const rawRows = accounts.map((acc, idx) => {
    const isActive = acc.id === activeAccountId;
    const num = String(idx + 1).padStart(idxWidth, '0');
    const accountCell = acc.alias ? `${acc.alias} (${acc.email})` : acc.email;

    // A status that blocks the reading belongs in one cell, not in all four
    // quota columns. It takes the plan slot because a token agy-auth cannot use
    // is the more actionable fact, and an unusable account rarely has a plan.
    const blocked = blockingStatusLabel(acc.status);

    const cells: Record<ColumnKey, Cell> = {
      plan: blocked ? { text: blocked, isError: true } : { text: formatPlan(acc), isError: false },
      gemini5h: formatQuotaCell(quotaWindow(acc, 'gemini5h'), nowMs),
      geminiWk: formatQuotaCell(quotaWindow(acc, 'geminiWk'), nowMs),
      claude5h: formatQuotaCell(quotaWindow(acc, 'claude5h'), nowMs),
      claudeWk: formatQuotaCell(quotaWindow(acc, 'claudeWk'), nowMs),
      last: { text: formatTimeAgo(acc.lastUsedAt), isError: false },
    };

    return { acc, idx, isActive, num, accountCell, cells };
  });

  const naturalWidth = (key: ColumnKey): number =>
    Math.max(
      stringWidth(COLUMN_HEADERS[key]),
      ...rawRows.map((r) => stringWidth(r.cells[key].text))
    );

  const widths: Record<ColumnKey, number> = {
    plan: Math.min(naturalWidth('plan'), MAX_PLAN_WIDTH),
    gemini5h: naturalWidth('gemini5h'),
    geminiWk: naturalWidth('geminiWk'),
    claude5h: naturalWidth('claude5h'),
    claudeWk: naturalWidth('claudeWk'),
    last: naturalWidth('last'),
  };

  const prefixWidth = 2 + idxWidth + 1; // "* 01 " or "  01 "
  const maxNaturalAccount = Math.max(
    stringWidth('ACCOUNT'),
    ...rawRows.map((r) => stringWidth(r.accountCell))
  );

  // Accounts are chosen by this column, so it keeps the width at which no two
  // labels truncate alike, such as two addresses sharing their first ten letters.
  const labels = rawRows.map((r) => r.accountCell);
  const distinctLabels = new Set(labels).size;
  let minAccountW = Math.min(maxNaturalAccount, MIN_ACCOUNT_WIDTH);
  while (
    minAccountW < maxNaturalAccount &&
    new Set(labels.map((label) => truncateAccount(label, minAccountW))).size < distinctLabels
  ) {
    minAccountW++;
  }

  let visible: ColumnKey[] = ['plan', 'gemini5h', 'geminiWk', 'claude5h', 'claudeWk', 'last'];

  const getOtherColumnsWidth = (): number =>
    visible.reduce((sum, key) => sum + COLUMN_SEPARATOR_WIDTH + widths[key], 0);

  // Drop columns if minimum account width plus columns exceeds terminal width
  for (const key of COLUMN_DROP_ORDER) {
    if (prefixWidth + minAccountW + getOtherColumnsWidth() <= termWidth) {
      break;
    }
    visible = visible.filter((candidate) => candidate !== key);
  }

  // Allocate account column width using available slack up to natural width
  const availableForAccount = Math.max(
    minAccountW,
    termWidth - prefixWidth - getOtherColumnsWidth()
  );
  let accountW = Math.min(maxNaturalAccount, availableForAccount);

  if (prefixWidth + accountW + getOtherColumnsWidth() > termWidth) {
    // Only drop/shrink when terminal is extremely constrained
    const remaining = termWidth - prefixWidth - getOtherColumnsWidth();
    accountW = Math.max(0, remaining);
  }

  const headerParts = [truncatePadded('ACCOUNT', accountW)];
  for (const key of visible) {
    headerParts.push(pad(COLUMN_HEADERS[key], widths[key]));
  }

  const rawHeader = ' '.repeat(prefixWidth) + headerParts.join('  ');
  const headerLine = truncateToWidth(colors.cyanBold(rawHeader), termWidth, '');
  const dividerLen = Math.min(stringWidth(rawHeader), termWidth);
  const dividerLine = colors.dim('─'.repeat(Math.max(0, dividerLen)));

  const rows: TableRowComponent[] = rawRows.map((r) => {
    const marker = r.isActive ? `* ${r.num} ` : `  ${r.num} `;
    // An alias alone beats an address cut off mid-word when both cannot fit.
    const label =
      r.acc.alias && stringWidth(r.accountCell) > accountW ? r.acc.alias : r.accountCell;
    const account = pad(truncateAccount(label, accountW), accountW);

    const cellsUncolored: string[] = [account];
    const cellsColored: string[] = [colorAccount(r.acc, account, r.isActive)];

    for (const key of visible) {
      const cell = truncatePadded(r.cells[key].text, widths[key]);
      cellsUncolored.push(cell);
      cellsColored.push(colorCell(key, r.cells[key], cell, r.isActive));
    }

    const choiceText = truncateToWidth(`${marker}${cellsUncolored.join('  ')}`, termWidth, '');
    const coloredMarker = r.isActive ? colors.bold(colors.green(marker)) : colors.dim(marker);
    const coloredText = truncateToWidth(
      `${coloredMarker}${cellsColored.join('  ')}`,
      termWidth,
      ''
    );

    return {
      account: r.acc,
      index: r.idx,
      isActive: r.isActive,
      marker,
      choiceText,
      coloredText,
    };
  });

  return { headerLine, dividerLine, rows };
}

export function renderAccountsTable(
  accounts: Account[],
  activeAccountId: string | null,
  maxWidthOverride?: number
): string {
  if (accounts.length === 0) {
    return `\n  ${NO_ACCOUNTS}\n`;
  }

  const { headerLine, dividerLine, rows } = getTableComponents(
    accounts,
    activeAccountId,
    maxWidthOverride
  );
  const rowLines = rows.map((r) => r.coloredText);

  // A session to renew comes first: until then its quota cannot be read anyway.
  const oauth = accounts.filter((a) => a.authType === 'oauth');
  const hasExpired = oauth.some(needsSignIn);
  const hasUncachedQuota = oauth.some(
    (a) => !needsSignIn(a) && (!a.rateLimit || Object.keys(a.rateLimit).length === 0)
  );

  let hintLine = '';
  if (hasExpired) {
    hintLine = `\n  ${colors.dim("Hint: To renew an account that needs a sign-in, sign in to it through Antigravity, then run 'agy-auth add'.")}\n`;
  } else if (hasUncachedQuota) {
    hintLine = `\n  ${colors.dim("Hint: Run 'agy-auth list --check' to fetch live quota over the network.")}\n`;
  }

  return `\n${headerLine}\n${dividerLine}\n${rowLines.join('\n')}\n${hintLine}`;
}

export function renderSelectMenu(
  accounts: Account[],
  activeAccountId: string | null,
  selectedIndex: number,
  typedBuffer: string,
  message = 'Select account to activate:',
  maxWidthOverride?: number
): string {
  const { headerLine, dividerLine, rows } = getTableComponents(
    accounts,
    activeAccountId,
    maxWidthOverride
  );

  const lines: string[] = [];
  lines.push(message);
  lines.push('');
  lines.push(headerLine);
  lines.push(dividerLine);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isSelected = i === selectedIndex;
    const isAct = r.isActive;

    let marker = '  ';
    if (isSelected && isAct) {
      marker = '* ';
    } else if (isSelected) {
      marker = '> ';
    } else if (isAct) {
      marker = '* ';
    }

    const rowBody = r.choiceText.slice(2);
    const fullRow = `${marker}${rowBody}`;

    if (isSelected && isAct) {
      lines.push(colors.bold(colors.green(fullRow)));
    } else if (isSelected) {
      lines.push(colors.bold(colors.cyan(fullRow)));
    } else {
      lines.push(r.coloredText);
    }
  }

  lines.push('');
  const helpText = '↑/↓ or j/k to move · Enter to select · Esc to cancel';
  if (typedBuffer) {
    lines.push(`  ${colors.dim(helpText)}  ${colors.dim(`(Type: ${typedBuffer})`)}`);
  } else {
    lines.push(`  ${colors.dim(helpText)}`);
  }

  return lines.join('\n');
}
