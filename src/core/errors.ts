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
