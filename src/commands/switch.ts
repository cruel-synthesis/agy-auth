import { AccountNotFoundError, AmbiguousSelectorError, UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { Switcher } from '../core/switcher.js';
import { Account, SwitchResult } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';
import { promptSelectAccount } from '../ui/tui.js';

interface SwitchOptions {
  json?: boolean;
}

export async function switchCommand(query?: string, options: SwitchOptions = {}): Promise<void> {
  const registry = new RegistryManager();
  const accounts = registry.getAccounts();
  const active = registry.getActiveAccount();

  if (accounts.length === 0) {
    throw new UsageError('No accounts registered. Run `agy-auth login` to add an account.');
  }

  let target: Account | null = null;

  if (query === '-') {
    const prev = registry.getPreviousAccount();
    if (!prev) {
      throw new UsageError('No previous account recorded in registry.');
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
        active?.id || null,
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
    target = await promptSelectAccount(accounts, active?.id || null, 'Select account to activate:');
    if (!target) return;
  }

  if (!target) return;

  const result: SwitchResult = Switcher.switchAccount(target);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'switch',
          ok: true,
          data: {
            previousAccount: result.previousAccount,
            currentAccount: result.currentAccount,
            antigravityUpdated: result.antigravityUpdated,
            adcUpdated: result.adcUpdated,
            requiresShellUpdate: result.requiresShellUpdate,
            managedEnvVars: result.managedEnvVars,
            warnings: result.warnings && result.warnings.length > 0 ? result.warnings : undefined,
          },
        },
        null,
        2
      )
    );
    return;
  }

  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.error(colors.yellow(`  Warning: ${warning}`));
    }
  }

  console.log(`\n  Switched to ${colors.green(formatAccountShort(result.currentAccount))}`);
  if (result.requiresShellUpdate) {
    console.log(`  ${colors.dim('To apply environment changes to your current shell session:')}`);
    console.log(`    ${colors.cyan('eval "$(agy-auth env)"')}\n`);
  }
}
