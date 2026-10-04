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
