import { AccountNotFoundError, AmbiguousSelectorError, UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { sanitizeAccount } from '../core/types.js';
import { colors } from '../ui/theme.js';

const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

interface AliasOptions {
  json?: boolean;
}

export async function aliasSetCommand(
  accountQuery: string,
  alias: string,
  options: AliasOptions = {}
): Promise<void> {
  const registry = new RegistryManager();
  const matches = registry.findAccounts(accountQuery);
  if (matches.length === 0) {
    throw new AccountNotFoundError(accountQuery);
  }
  if (matches.length > 1) {
    throw new AmbiguousSelectorError(
      accountQuery,
      matches.map((m) => m.alias || m.email)
    );
  }

  const account = matches[0];
  const trimmedAlias = alias.trim();
  if (!trimmedAlias) {
    throw new UsageError('Alias cannot be empty.');
  }

  if (!ALIAS_REGEX.test(trimmedAlias)) {
    throw new UsageError(
      `Invalid alias '${trimmedAlias}'. Alias must start with an alphanumeric character and contain up to 32 alphanumeric, hyphen, or underscore characters.`
    );
  }

  registry.setAlias(account.id, trimmedAlias);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after setting alias.`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'alias set',
          ok: true,
          data: {
            account: sanitizeAccount(updated),
            alias: trimmedAlias,
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `\n  ${colors.green('[ok]')} Set alias '${colors.cyan(trimmedAlias)}' for ${updated.email}\n`
  );
}

export async function aliasClearCommand(
  accountQuery: string,
  options: AliasOptions = {}
): Promise<void> {
  const registry = new RegistryManager();
  const matches = registry.findAccounts(accountQuery);
  if (matches.length === 0) {
    throw new AccountNotFoundError(accountQuery);
  }
  if (matches.length > 1) {
    throw new AmbiguousSelectorError(
      accountQuery,
      matches.map((m) => m.alias || m.email)
    );
  }

  const account = matches[0];
  registry.setAlias(account.id, null);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after clearing alias.`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'alias clear',
          ok: true,
          data: {
            account: sanitizeAccount(updated),
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n  ${colors.green('[ok]')} Cleared alias for ${updated.email}\n`);
}
