import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import {
  AccountNotFoundError,
  AmbiguousSelectorError,
  CliError,
  UsageError,
} from '../core/errors.js';
import { Paths } from '../core/paths.js';
import { RegistryManager } from '../core/registry.js';
import { Account, sanitizeAccount } from '../core/types.js';
import { NO_ACCOUNTS, formatAccountShort } from '../ui/format.js';
import { colors, marks } from '../ui/theme.js';
import { promptSelectAccount } from '../ui/tui.js';

interface RemoveOptions {
  yes?: boolean;
  all?: boolean;
  json?: boolean;
}

export async function removeCommand(
  selectors: string[] = [],
  options: RemoveOptions = {}
): Promise<void> {
  if (options.all && selectors.length > 0) {
    throw new UsageError('Do not combine account selectors with --all.');
  }

  const registry = new RegistryManager();
  const accounts = registry.getAccounts();
  const active = registry.getActiveAccount();

  if (accounts.length === 0) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'remove',
            ok: true,
            data: {
              removed: [],
              remainingCount: 0,
              activeAccountId: null,
              managedBackupCreated: false,
            },
          },
          null,
          2
        )
      );
      return;
    }
    console.log(NO_ACCOUNTS);
    return;
  }

  // Enforcement: JSON and non-TTY removal require --yes
  if (options.json && !options.yes) {
    throw new UsageError('Removing accounts in JSON mode requires --yes.');
  }
  if (!process.stdin.isTTY && !options.yes) {
    throw new UsageError('Removing accounts in non-interactive mode requires --yes.');
  }

  // Case 1: --all
  if (options.all) {
    if (!options.yes && process.stdin.isTTY) {
      const proceed = await confirm({
        message: `Are you sure you want to remove ALL ${accounts.length} account(s) from agy-auth?`,
        default: false,
      });
      if (!proceed) {
        console.log('Cancelled.');
        return;
      }
    }

    const removedAccounts = [...accounts];
    await registry.mutate(
      (draft) => {
        draft.accounts = [];
        draft.activeAccountId = null;
        draft.previousAccountId = null;
      },
      { backupPrefix: 'remove_all' }
    );

    // Clean up managed service account files
    const cleanupErrors: Array<{ accountId: string; file: string; error: string }> = [];
    for (const acc of removedAccounts) {
      if (acc.authType === 'service-account') {
        const saFile = path.join(Paths.accountsDir, `${path.basename(acc.id)}.json`);
        try {
          if (fs.existsSync(saFile)) {
            fs.unlinkSync(saFile);
          }
        } catch (err) {
          cleanupErrors.push({
            accountId: acc.id,
            file: saFile,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (cleanupErrors.length > 0) {
      throw new CliError(
        'Account metadata was removed, but one or more credential key files could not be deleted from disk.',
        'cleanup_failed',
        1,
        {
          removed: removedAccounts.map(sanitizeAccount),
          remainingFiles: cleanupErrors,
        }
      );
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'remove',
            ok: true,
            data: {
              removed: removedAccounts.map(sanitizeAccount),
              remainingCount: 0,
              activeAccountId: null,
              managedBackupCreated: true,
            },
          },
          null,
          2
        )
      );
      return;
    }

    console.log(`\n  ${marks.ok} Removed all ${removedAccounts.length} account(s) from agy-auth.`);
    console.log(
      `  ${colors.dim('Note: This removed local account metadata. External tokens and Antigravity credentials remain unchanged.')}\n`
    );
    console.log(
      `  ${colors.dim('A managed recovery backup retains the pre-removal registry. Run `agy-auth clean --all` to delete managed backups.')}\n`
    );
    return;
  }

  // Case 2: No selectors provided -> interactive picker
  if (selectors.length === 0) {
    // A picker would write its prompt into the JSON on stdout.
    if (options.json) {
      throw new UsageError('Name the account to remove, or pass --all.');
    }
    const selected = await promptSelectAccount(
      accounts,
      active?.id || null,
      'Select account to remove:'
    );
    if (!selected) return;
    selectors = [selected.id];
  }

  // Case 3: Resolve EVERY selector before any mutation (atomic resolution)
  const targetsToRemove: Account[] = [];
  const targetIds = new Set<string>();

  for (const selector of selectors) {
    const matches = registry.findAccounts(selector);
    if (matches.length === 0) {
      throw new AccountNotFoundError(selector);
    }
    if (matches.length > 1) {
      throw new AmbiguousSelectorError(
        selector,
        matches.map((m) => m.alias || m.email)
      );
    }
    const target = matches[0];
    if (!targetIds.has(target.id)) {
      targetIds.add(target.id);
      targetsToRemove.push(target);
    }
  }

  if (!options.yes && process.stdin.isTTY && targetsToRemove.length > 0) {
    const proceed = await confirm({
      message:
        targetsToRemove.length === 1
          ? `Remove account '${formatAccountShort(targetsToRemove[0])}'?`
          : `Remove ${targetsToRemove.length} accounts?`,
      default: true,
    });
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }
  }

  // Perform atomic removal
  await registry.mutate(
    (draft) => {
      for (const target of targetsToRemove) {
        const idx = draft.accounts.findIndex((a) => a.id === target.id);
        if (idx !== -1) {
          draft.accounts.splice(idx, 1);
        }
        if (draft.activeAccountId === target.id) {
          draft.activeAccountId = null;
          draft.previousAccountId = null;
        } else if (draft.previousAccountId === target.id) {
          draft.previousAccountId = null;
        }
      }
    },
    { backupPrefix: 'remove' }
  );

  // Clean up managed service account files
  const cleanupErrors: Array<{ accountId: string; file: string; error: string }> = [];
  for (const target of targetsToRemove) {
    if (target.authType === 'service-account') {
      const saFile = path.join(Paths.accountsDir, `${path.basename(target.id)}.json`);
      try {
        if (fs.existsSync(saFile)) {
          fs.unlinkSync(saFile);
        }
      } catch (err) {
        cleanupErrors.push({
          accountId: target.id,
          file: saFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (cleanupErrors.length > 0) {
    throw new CliError(
      'Account metadata was removed, but one or more credential key files could not be deleted from disk.',
      'cleanup_failed',
      1,
      {
        removed: targetsToRemove.map(sanitizeAccount),
        remainingFiles: cleanupErrors,
      }
    );
  }

  const freshRegistry = registry.getRegistry();

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'remove',
          ok: true,
          data: {
            removed: targetsToRemove.map(sanitizeAccount),
            remainingCount: freshRegistry.accounts.length,
            activeAccountId: freshRegistry.activeAccountId,
            managedBackupCreated: true,
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n  ${marks.ok} Removed ${targetsToRemove.length} account(s):`);
  for (const t of targetsToRemove) {
    console.log(`    - ${formatAccountShort(t)}`);
  }
  if (!freshRegistry.activeAccountId) {
    console.log(`\n  ${colors.dim('No active account configured in registry.')}`);
  }
  console.log(
    `  ${colors.dim('Note: agy-auth remove does not sign out of Google or delete external files.')}\n`
  );
  console.log(
    `  ${colors.dim('A managed recovery backup retains the pre-removal registry. Run `agy-auth clean --all` to delete managed backups.')}\n`
  );
}
