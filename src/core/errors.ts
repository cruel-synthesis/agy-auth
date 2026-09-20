import { ZodError } from 'zod';

/**
 * One line naming the first field that failed validation and how many others
 * did. A ZodError's own message is a pretty-printed array of every issue: a
 * debugging artefact rather than something a reader can act on.
 */
export function describeSchemaFailure(error: ZodError): string {
  const [first, ...rest] = error.issues;
  if (!first) return 'it does not match the expected schema';
  const field = first.path.length > 0 ? first.path.join('.') : 'the document';
  const others = rest.length > 0 ? ` (and ${rest.length} more)` : '';
  // Only the opening word is lowered: a message that quotes a field name must
  // still quote it as the file spells it.
  const detail = first.message.charAt(0).toLowerCase() + first.message.slice(1);
  return `${field}: ${detail}${others}`;
}

export class CliError extends Error {
  public readonly code: string;
  public readonly exitCode: number;
  public readonly details: Record<string, unknown>;

  constructor(
    message: string,
    code = 'cli_error',
    exitCode = 1,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends CliError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'invalid_usage', 2, details);
    this.name = 'UsageError';
  }
}

export class AccountNotFoundError extends CliError {
  constructor(query: string) {
    super(`No account matches the selector '${query}'.`, 'account_not_found', 1, { query });
    this.name = 'AccountNotFoundError';
  }
}

export class AmbiguousSelectorError extends CliError {
  constructor(query: string, matches: string[]) {
    super(
      `Multiple accounts match '${query}'. Use an exact alias or account ID. Matches: ${matches.join(', ')}`,
      'ambiguous_selector',
      1,
      { query, matches }
    );
    this.name = 'AmbiguousSelectorError';
  }
}

export class CancellationError extends CliError {
  constructor(message = 'Operation cancelled.') {
    super(message, 'cancelled', 130);
    this.name = 'CancellationError';
  }
}
