import { AccountNotFoundError, AmbiguousSelectorError, UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { checkAlias, sanitizeAccount } from '../core/types.js';
import { colors, marks } from '../ui/theme.js';

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
  checkAlias(trimmedAlias);

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

  console.log(`\n  ${marks.ok} Set alias '${colors.cyan(trimmedAlias)}' for ${updated.email}\n`);
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

  console.log(`\n  ${marks.ok} Cleared alias for ${updated.email}\n`);
}
