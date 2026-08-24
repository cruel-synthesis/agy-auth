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
  greenBold: (str: string) => pc.bold(pc.green(str)),
  red: (str: string) => pc.red(str),
  redBold: (str: string) => pc.bold(pc.red(str)),
  yellow: (str: string) => pc.yellow(str),
  dim: (str: string) => pc.dim(str),
  bold: (str: string) => pc.bold(str),
};

export const theme = {
  header: (str: string) => colors.cyan(str),
  activeRow: (str: string) => colors.green(str),
  success: (str: string) => colors.green(str),
  error: (str: string) => colors.red(str),
  hint: (str: string) => colors.cyan(str),
  dim: (str: string) => colors.dim(str),
  bold: (str: string) => colors.bold(str),
};
