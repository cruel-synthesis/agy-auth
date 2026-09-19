import { input, password } from '@inquirer/prompts';
import { readAntigravityToken } from '../core/antigravity-store.js';
import { CredentialFiles } from '../core/credential-files.js';
import { isEmail } from '../core/credential-validation.js';
import { Discovery } from '../core/discovery.js';
import { CancellationError, CliError, UsageError } from '../core/errors.js';
import { type ImportKeychainOAuthResult, importKeychainOAuth } from '../core/keychain-import.js';
import { Paths } from '../core/paths.js';
import { RegistryManager } from '../core/registry.js';
import { AccountCredentials, AuthType, sanitizeAccount } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';

const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

interface AddOptions {
  apiKey?: string | boolean;
  serviceAccount?: string;
  adc?: string | boolean;
  email?: string;
  alias?: string;
  project?: string;
  location?: string;
  model?: string;
  yes?: boolean;
  json?: boolean;
}

export interface AddServices {
  fetchFn?: typeof fetch;
}

export function validateEmailInput(value: string): boolean | string {
  return isEmail(value.trim()) ? true : 'Please enter a valid email address.';
}

export async function addCommand(options: AddOptions, services?: AddServices): Promise<void> {
  const methodCount =
    (options.apiKey !== undefined ? 1 : 0) +
    (options.serviceAccount ? 1 : 0) +
    (options.adc !== undefined ? 1 : 0);

  if (methodCount > 1) {
    throw new UsageError(
      'Specify at most one credential type (--api-key <key>, --service-account <path>, or --adc [path]).'
    );
  }

  // Plain `add` means the account the user is already signed into, which is the
  // only one most people ever need. The flags below cover credential types that
  // Antigravity does not hold.
  if (methodCount === 0) {
    await addAntigravityAccount(options, services);
    return;
  }

  const alias = options.alias ? options.alias.trim() : undefined;
  if (alias && !ALIAS_REGEX.test(alias)) {
    throw new UsageError(
      `Invalid alias '${alias}'. Alias must start with alphanumeric and contain up to 32 alphanumeric, hyphen, or underscore characters.`
    );
  }

  let authType: AuthType;
  let email: string;
  let credentials: AccountCredentials | undefined;
  let defaultProject = options.project?.trim();

  if (options.apiKey !== undefined) {
    authType = 'api-key';
    let key: string;
    if (typeof options.apiKey === 'string') {
      key = options.apiKey.trim();
    } else {
      if (options.json) {
        throw new UsageError(
          'A value is required for --api-key in JSON mode. Pass --api-key <key>.'
        );
      }
      if (!process.stdin.isTTY) {
        throw new UsageError(
          'A value is required for --api-key in non-interactive mode. Run in a TTY for masked entry or pass --api-key <key>.'
        );
      }
      try {
        key = (
          await password({
            message: 'Gemini API key:',
            mask: '*',
            validate: (value) => (value.trim() ? true : 'API key cannot be empty.'),
          })
        ).trim();
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'ExitPromptError') {
          throw new CancellationError();
        }
        throw error;
      }
    }
    if (!key) throw new UsageError('API key cannot be empty.');
    credentials = { apiKey: key };

    if (options.email) {
      const em = options.email.trim();
      if (!isEmail(em)) {
        throw new UsageError(`Invalid email address '${options.email}'.`);
      }
      email = em;
    } else if (alias) {
      email = `${alias.toLowerCase()}@local.invalid`;
    } else {
      throw new UsageError('Adding an API key requires --email <email> or --alias <alias>.');
    }
  } else if (options.serviceAccount) {
    authType = 'service-account';
    const saPath = options.serviceAccount.trim();
    if (!saPath) throw new UsageError('Service account file path cannot be empty.');
    const saKey = CredentialFiles.loadServiceAccountKeyFile(saPath);
    credentials = { serviceAccountKey: saKey };

    if (options.email) {
      const em = options.email.trim();
      if (!isEmail(em)) {
        throw new UsageError(`Invalid email address '${options.email}'.`);
      }
      if (em.toLowerCase() !== saKey.client_email.toLowerCase()) {
        throw new UsageError(
          `Provided --email '${options.email}' does not match service account client_email '${saKey.client_email}'.`
        );
      }
    }
    email = saKey.client_email;
    if (!defaultProject) {
      defaultProject = saKey.project_id;
    }
  } else {
    authType = 'adc';
    if (typeof options.adc === 'string' && options.adc.trim()) {
      const adcPath = options.adc.trim();
      CredentialFiles.loadAdcFile(adcPath);
      credentials = { adcPath };
    } else {
      CredentialFiles.loadAdcFile(Paths.gcloudAdcFile);
      credentials = { adcPath: Paths.gcloudAdcFile };
    }

    const discoveredEmail = Discovery.discoverFromAdc()?.email;
    if (options.email) {
      const em = options.email.trim();
      if (!isEmail(em)) {
        throw new UsageError(`Invalid email address '${options.email}'.`);
      }
      email = em;
    } else if (discoveredEmail) {
      email = discoveredEmail;
    } else if (alias) {
      email = `${alias.toLowerCase()}@local.invalid`;
    } else {
      throw new UsageError('Adding ADC credentials requires --email <email> or --alias <alias>.');
    }
  }

  const registry = new RegistryManager();
  const account = registry.addOrUpdateAccount({
    email,
    alias,
    authType,
    credentials,
    gcpProject: defaultProject,
    gcpLocation: options.location?.trim() || undefined,
    model: options.model?.trim() || undefined,
    status: 'unverified',
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'add',
          ok: true,
          data: {
            account: sanitizeAccount(account),
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `\n  ${colors.green('[ok]')} Account added: ${colors.green(formatAccountShort(account))}`
  );
  console.log(
    `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate this account.\n`
  );
}

/**
 * Import the Google account currently signed in to Antigravity.
 *
 * Antigravity owns the sign-in; this reads the session it already holds and
 * records the account, so it both adds an account for the first time and
 * refreshes the stored session of one that is already saved.
 */
async function addAntigravityAccount(options: AddOptions, services?: AddServices): Promise<void> {
  const registry = new RegistryManager();
  const tokenState = readAntigravityToken();

  if (tokenState.status === 'error') {
    throw new CliError(
      `Could not read the Antigravity session: ${tokenState.warning || 'the session store is unreadable.'}`,
      'session_store_error',
      1
    );
  }

  if (tokenState.status !== 'found') {
    throw new CliError(
      'No Antigravity session found. Sign in to Antigravity, then run `agy-auth add` again.',
      'no_session',
      1
    );
  }

  const importSession = async (email?: string): Promise<ImportKeychainOAuthResult> =>
    importKeychainOAuth({ email, fetchFn: services?.fetchFn, registry });

  let result = await importSession(options.email?.trim());

  // Google does not always return the address with the session. Asking is the
  // only way to attribute it, and a wrong guess would label the wrong account.
  if (result.status === 'needs_email') {
    if (!process.stdin.isTTY || options.yes || options.json) {
      throw new UsageError(
        'Could not determine the account email. Pass `agy-auth add --email <email>`.'
      );
    }
    try {
      const answer = await input({
        message: 'Enter the Google account email signed in to Antigravity:',
        validate: validateEmailInput,
      });
      result = await importSession(answer.trim());
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ExitPromptError') {
        throw new CancellationError();
      }
      throw error;
    }
  }

  if (result.status !== 'success') {
    throw new CliError(
      'Could not import the Antigravity session. Sign in to Antigravity again, then retry.',
      'import_failed',
      1
    );
  }

  const account = result.account;

  if (options.json) {
    console.log(
      JSON.stringify(
        { schemaVersion: 1, command: 'add', ok: true, data: { account: sanitizeAccount(account) } },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n  ${colors.green('[ok]')} Added ${colors.green(formatAccountShort(account))}`);
  console.log(
    `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to use it.\n`
  );
}
