import pc from 'picocolors';

/**
 * Semantic terminal colors used by the CLI.
 * - Headers / Hints / Action lines: cyan
 * - Active Row / Success: green
 * - Errors: red
 * - Secondary text / metadata: dim
 * - Primary content: default terminal foreground
 */
export const colors = {
  cyan: (str: string) => pc.cyan(str),
  cyanBold: (str: string) => pc.bold(pc.cyan(str)),
  green: (str: string) => pc.green(str),
  red: (str: string) => pc.red(str),
  yellow: (str: string) => pc.yellow(str),
  dim: (str: string) => pc.dim(str),
  bold: (str: string) => pc.bold(str),
};

/** Status marks shared by every command that reports an outcome. */
export const marks = {
  ok: colors.green('✓'),
  warn: colors.yellow('!'),
  fail: colors.red('✗'),
};

/** Colour for a remaining-quota percentage: plenty, getting low, nearly gone. */
export function quotaColor(remaining: number): (str: string) => string {
  if (remaining < 20) return colors.red;
  if (remaining < 50) return colors.yellow;
  return colors.green;
}
