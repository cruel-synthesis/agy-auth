import { UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { checkAlias, sanitizeAccount } from '../core/types.js';
import { printJsonResult } from '../ui/format.js';
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
  const account = registry.resolveAccount(accountQuery);
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
    printJsonResult('alias set', {
      account: sanitizeAccount(updated),
      alias: trimmedAlias,
    });
    return;
  }

  console.log(`\n  ${marks.ok} Set alias '${colors.cyan(trimmedAlias)}' for ${updated.email}\n`);
}

export async function aliasClearCommand(
  accountQuery: string,
  options: AliasOptions = {}
): Promise<void> {
  const registry = new RegistryManager();
  const account = registry.resolveAccount(accountQuery);
  registry.setAlias(account.id, null);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after clearing alias.`);
  }

  if (options.json) {
    printJsonResult('alias clear', {
      account: sanitizeAccount(updated),
    });
    return;
  }

  console.log(`\n  ${marks.ok} Cleared alias for ${updated.email}\n`);
}
