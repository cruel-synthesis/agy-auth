import { applyEnvCommand } from '../core/env-vars.js';
import {
  AccountNotFoundError,
  AmbiguousSelectorError,
  CliError,
  UsageError,
} from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { Switcher } from '../core/switcher.js';
import { Account, needsSignIn } from '../core/types.js';
import { formatAccountShort, NO_ACCOUNTS, printJsonResult } from '../ui/format.js';
import { colors } from '../ui/theme.js';
import { promptSelectAccount } from '../ui/tui.js';

interface SwitchOptions {
  json?: boolean;
}

export async function switchCommand(query?: string, options: SwitchOptions = {}): Promise<void> {
  const registry = new RegistryManager();
  const { accounts, activeAccountId } = registry.getRegistry();

  if (accounts.length === 0) {
    throw new CliError(NO_ACCOUNTS, 'no_accounts');
  }

  let target: Account | null = null;

  if (query === '-') {
    const prev = registry.getPreviousAccount();
    if (!prev) {
      throw new CliError('No previous account recorded.', 'no_previous_account');
    }
    target = prev;
  } else if (query?.trim()) {
    const matches = registry.findAccounts(query);
    if (matches.length === 0) {
      throw new AccountNotFoundError(query);
    }
    if (matches.length > 1) {
      if (!process.stdout.isTTY || options.json) {
        throw new AmbiguousSelectorError(
          query,
          matches.map((m) => m.alias || m.email)
        );
      }
      target = await promptSelectAccount(
        matches,
        activeAccountId,
        `Multiple accounts matched '${query}'. Select one:`
      );
      if (!target) return;
    } else {
      target = matches[0];
    }
  } else if (!process.stdout.isTTY || options.json) {
    throw new UsageError(
      'Account selector required in non-interactive mode. Usage: agy-auth switch <account>'
    );
  } else {
    target = await promptSelectAccount(accounts, activeAccountId, 'Select account to activate:');
    if (!target) return;
  }

  const result = Switcher.switchAccount(target);
  // Switching is still allowed: the user may be about to sign in again.
  const warnings = [...(result.warnings ?? [])];
  if (needsSignIn(result.currentAccount)) {
    warnings.push(
      result.currentAccount.authType === 'oauth'
        ? `${formatAccountShort(result.currentAccount)} needs a sign-in; sign in to it through Antigravity, then run \`agy-auth add\`.`
        : `${formatAccountShort(result.currentAccount)} was rejected; add it again with a working credential.`
    );
  }

  if (options.json) {
    printJsonResult('switch', {
      previousAccount: result.previousAccount,
      currentAccount: result.currentAccount,
      antigravityUpdated: result.antigravityUpdated,
      adcUpdated: result.adcUpdated,
      requiresShellUpdate: result.requiresShellUpdate,
      managedEnvVars: result.managedEnvVars,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
    return;
  }

  for (const warning of warnings) {
    console.error(colors.yellow(`  Warning: ${warning}`));
  }

  console.log(`\n  Switched to ${colors.green(formatAccountShort(result.currentAccount))}`);
  if (result.requiresShellUpdate) {
    console.log(`  ${colors.dim('To apply environment changes to your current shell session:')}`);
    console.log(`    ${colors.cyan(applyEnvCommand())}\n`);
  }
}
