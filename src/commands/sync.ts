import { input } from '@inquirer/prompts';
import { readAntigravityToken } from '../core/antigravity-store.js';
import { isEmail } from '../core/credential-validation.js';
import { Discovery } from '../core/discovery.js';
import { CancellationError, CliError, UsageError } from '../core/errors.js';
import { importKeychainOAuth } from '../core/keychain-import.js';
import { RegistryManager } from '../core/registry.js';
import { type Account, sanitizeAccount } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';

export function validateSyncEmail(val: string): boolean | string {
  return isEmail(val.trim()) ? true : 'Please enter a valid email address.';
}

export interface SyncOptions {
  oauthEmail?: string;
  adcEmail?: string;
  yes?: boolean;
  json?: boolean;
}

export interface SyncServices {
  fetchFn?: typeof fetch;
}

export async function syncCommand(
  options: SyncOptions = {},
  services?: SyncServices
): Promise<void> {
  const registry = new RegistryManager();
  const syncedAccounts: Account[] = [];
  const skippedItems: string[] = [];

  // 1. Read Antigravity session token using composite store
  const tokenState = readAntigravityToken();
  if (tokenState.status === 'error') {
    throw new CliError(
      `Antigravity Keychain read error: ${tokenState.warning || 'Failed to read token payload.'}`,
      'keychain_error',
      1
    );
  }
  if (tokenState.status === 'found') {
    let importResult = await importKeychainOAuth({
      email: options.oauthEmail,
      fetchFn: services?.fetchFn,
      registry,
    });

    if (importResult.status === 'needs_email') {
      if (process.stdin.isTTY && !options.yes && !options.json) {
        try {
          const promptEmail = await input({
            message: 'Enter the Google account email signed in to Antigravity:',
            validate: validateSyncEmail,
          });
          importResult = await importKeychainOAuth({
            email: promptEmail.trim(),
            fetchFn: services?.fetchFn,
            registry,
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'ExitPromptError') {
            throw new CancellationError();
          }
          throw err;
        }
      } else {
        skippedItems.push(
          'Active Antigravity Keychain token (email not specified; use `agy-auth sync --oauth-email <email>`)'
        );
      }
    }

    if (importResult.status === 'success') {
      syncedAccounts.push(importResult.account);
    }
  }

  // 2. Discover local ADC
  const adcDiscovered = Discovery.discoverFromAdc();
  if (adcDiscovered) {
    let email = options.adcEmail?.trim() || adcDiscovered.email;

    if (!email && process.stdin.isTTY && !options.yes && !options.json) {
      try {
        const promptEmail = await input({
          message: 'Enter email for local ADC credentials:',
          validate: validateSyncEmail,
        });
        email = promptEmail.trim();
      } catch (err) {
        if (err instanceof Error && err.name === 'ExitPromptError') {
          throw new CancellationError();
        }
        throw err;
      }
    }

    if (email) {
      if (!isEmail(email)) {
        throw new UsageError(`Invalid ADC email address '${email}'.`);
      }
      const existing = registry
        .getAccounts()
        .find((a) => a.authType === 'adc' && a.email.toLowerCase() === email.toLowerCase());

      const acc = registry.addOrUpdateAccount({
        email,
        authType: 'adc',
        gcpProject: adcDiscovered.gcpProject ?? existing?.gcpProject,
        credentials: adcDiscovered.credentials || existing?.credentials,
        status: existing?.status || 'unverified',
      });
      syncedAccounts.push(acc);
    } else {
      skippedItems.push(
        'Local Application Default Credentials (email not specified; use `agy-auth sync --adc-email <email>`)'
      );
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'sync',
          ok: true,
          data: {
            synced: syncedAccounts.map(sanitizeAccount),
            skipped: skippedItems,
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n${colors.cyan('agy-auth')} - Credential Sync\n`);

  if (syncedAccounts.length === 0 && skippedItems.length === 0) {
    console.log('  No local Keychain or ADC credentials discovered.');
    console.log(
      '  Sign in through Google Antigravity or gcloud CLI, then rerun `agy-auth sync`.\n'
    );
    return;
  }

  if (syncedAccounts.length > 0) {
    console.log(colors.green(`  Synced ${syncedAccounts.length} profile(s):`));
    for (const acc of syncedAccounts) {
      console.log(`    - ${formatAccountShort(acc)} (${acc.authType})`);
    }
    console.log();
  }

  if (skippedItems.length > 0) {
    console.log(colors.yellow(`  Skipped ${skippedItems.length} item(s):`));
    for (const item of skippedItems) {
      console.log(`    - ${item}`);
    }
    console.log();
  }
}
