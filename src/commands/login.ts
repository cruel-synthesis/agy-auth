import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { input, select } from '@inquirer/prompts';
import { readAntigravityToken } from '../core/antigravity-store.js';
import { isEmail } from '../core/credential-validation.js';
import { CancellationError, CliError, UsageError } from '../core/errors.js';
import { importKeychainOAuth } from '../core/keychain-import.js';
import type { AgyKeychainPayload } from '../core/keychain.js';
import { assertNativeAllowed } from '../core/native-guard.js';
import { getOAuthClientConfig } from '../core/oauth-config.js';
import { type AuthenticateOptions, OAuthFlow, type OAuthResult } from '../core/oauth.js';
import { RegistryManager } from '../core/registry.js';
import type { Account } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';

const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ALLOWED_OAUTH_SOURCES = ['keychain', 'browser'] as const;
type OAuthSource = (typeof ALLOWED_OAUTH_SOURCES)[number];
type InteractiveOAuthSource = OAuthSource | 'antigravity';

export interface LoginOptions {
  oauthSource?: string;
  alias?: string;
  project?: string;
  location?: string;
  model?: string;
  email?: string;
}

export interface LoginServices {
  authenticateOAuth?: (options?: AuthenticateOptions) => Promise<OAuthResult>;
  fetchFn?: typeof fetch;
  openAntigravity?: () => boolean;
}

export function validateAliasInput(value: string): boolean | string {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return ALIAS_REGEX.test(trimmed)
    ? true
    : 'Alias must be alphanumeric with underscores/hyphens (max 32 chars).';
}

function printSavedAccount(account: Account, isNew: boolean): void {
  const action = isNew ? 'Profile added successfully' : 'Profile updated successfully';
  console.log(
    `\n  ${colors.green('[ok]')} ${action}: ${colors.green(formatAccountShort(account))}`
  );
  console.log(
    `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
  );
}

function openAntigravityApp(): boolean {
  if (os.platform() !== 'darwin') return false;
  assertNativeAllowed('Antigravity application launch');

  const result = spawnSync('/usr/bin/open', ['-a', 'Antigravity IDE'], { stdio: 'ignore' });
  return result.status === 0;
}

async function chooseOAuthSource(): Promise<InteractiveOAuthSource> {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      'Interactive login requires a TTY. Pass `--oauth-source keychain` or `--oauth-source browser` explicitly.'
    );
  }

  const isMac = os.platform() === 'darwin';
  const tokenState = readAntigravityToken();
  const sessionExpiry =
    tokenState.status === 'found' ? tokenState.payload?.token.expiry : undefined;
  const sessionExpiryMs = sessionExpiry ? Date.parse(sessionExpiry) : Number.NaN;
  const hasAntigravitySession =
    tokenState.status === 'found' &&
    (!Number.isFinite(sessionExpiryMs) || sessionExpiryMs > Date.now());
  const hasCustomOAuthClient = getOAuthClientConfig() !== null;
  const choices = [
    ...(hasAntigravitySession
      ? [
          {
            name: 'Use current Antigravity account',
            value: 'keychain' as const,
            description: 'Import the Google account currently signed in to Antigravity',
          },
        ]
      : []),
    ...(isMac
      ? [
          {
            name: hasAntigravitySession
              ? 'Sign in to another account through Antigravity'
              : 'Sign in through Antigravity',
            value: 'antigravity' as const,
            description: 'Open Antigravity, complete Google sign-in, then import the session',
          },
        ]
      : []),
    ...(hasCustomOAuthClient
      ? [
          {
            name: 'Sign in with a custom OAuth client',
            value: 'browser' as const,
            description: 'Use AGY_OAUTH_CLIENT_ID for a direct browser login',
          },
        ]
      : []),
  ];

  if (choices.length === 0) {
    throw new CliError(
      "No readable Antigravity session or configured browser login was found. agy-auth can import Antigravity's token file on this platform, but not its native OS keyring. Configure AGY_OAUTH_CLIENT_ID to enable custom browser sign-in.",
      'no_login_source',
      1
    );
  }

  try {
    return await select({
      message: 'Choose a Google account login:',
      choices,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      throw new CancellationError();
    }
    throw error;
  }
}

async function signInThroughAntigravity(
  options: LoginOptions,
  services: LoginServices | undefined,
  registry: RegistryManager
): Promise<void> {
  const opened = (services?.openAntigravity || openAntigravityApp)();
  if (opened) {
    console.log('\n  Complete Google sign-in in Antigravity, then return here.');
  } else {
    console.log('\n  Open Antigravity IDE and complete Google sign-in, then return here.');
  }

  try {
    await input({ message: 'Press Enter after Antigravity sign-in is complete:' });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      throw new CancellationError();
    }
    throw error;
  }

  await importCurrentAntigravityAccount(options, services, registry);
}

async function importCurrentAntigravityAccount(
  options: LoginOptions,
  services: LoginServices | undefined,
  registry: RegistryManager
): Promise<void> {
  let result = await importKeychainOAuth({
    email: options.email,
    alias: options.alias,
    project: options.project,
    location: options.location,
    model: options.model,
    fetchFn: services?.fetchFn,
    registry,
  });

  if (result.status === 'needs_email') {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        'Could not derive email from Antigravity session. Specify `--email <email>`.'
      );
    }

    let email: string;
    try {
      email = await input({
        message: 'Enter the Google account email signed in to Antigravity:',
        validate: (value) => (isEmail(value.trim()) ? true : 'Please enter a valid email address.'),
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ExitPromptError') {
        throw new CancellationError();
      }
      throw error;
    }

    result = await importKeychainOAuth({
      email: email.trim(),
      alias: options.alias,
      project: options.project,
      location: options.location,
      model: options.model,
      fetchFn: services?.fetchFn,
      registry,
    });
  }

  if (result.status !== 'success') {
    throw new CliError('Could not import the current Antigravity account.', 'oauth_import_failed');
  }

  printSavedAccount(result.account, result.isNew);
}

async function signInWithBrowser(
  options: LoginOptions,
  services: LoginServices | undefined,
  registry: RegistryManager
): Promise<void> {
  const authenticate = services?.authenticateOAuth || OAuthFlow.authenticate;
  const result = await authenticate({ fetchFn: services?.fetchFn });
  const normalizedEmail = result.email.toLowerCase();
  const existing = registry
    .getAccounts()
    .find(
      (account) => account.authType === 'oauth' && account.email.toLowerCase() === normalizedEmail
    );

  const refreshToken =
    result.payload.token.refresh_token ||
    existing?.credentials?.keychainPayload?.token?.refresh_token ||
    '';
  const payload: AgyKeychainPayload = {
    auth_method: 'consumer',
    token: {
      access_token: result.payload.token.access_token,
      token_type: result.payload.token.token_type || 'Bearer',
      refresh_token: refreshToken,
      expiry: result.payload.token.expiry,
    },
  };

  const account = registry.addOrUpdateAccount({
    email: result.email,
    alias: options.alias !== undefined ? options.alias.trim() || undefined : existing?.alias,
    authType: 'oauth',
    status: 'valid',
    gcpProject:
      options.project !== undefined ? options.project.trim() || undefined : existing?.gcpProject,
    gcpLocation:
      options.location !== undefined ? options.location.trim() || undefined : existing?.gcpLocation,
    model: options.model !== undefined ? options.model.trim() || undefined : existing?.model,
    credentials: { keychainPayload: payload },
  });

  printSavedAccount(account, !existing);
}

export async function loginCommand(
  options: LoginOptions = {},
  services?: LoginServices
): Promise<void> {
  if (
    options.oauthSource &&
    !ALLOWED_OAUTH_SOURCES.includes(options.oauthSource.toLowerCase() as OAuthSource)
  ) {
    throw new UsageError(
      `Invalid OAuth source "${options.oauthSource}". Allowed sources: ${ALLOWED_OAUTH_SOURCES.join(', ')}`
    );
  }

  if (options.alias !== undefined) {
    const valid = validateAliasInput(options.alias);
    if (typeof valid === 'string') {
      throw new UsageError(`Invalid alias "${options.alias}": ${valid}`);
    }
  }

  console.log(`\n${colors.cyan('agy-auth')} - Google Account Login\n`);

  const source = options.oauthSource
    ? (options.oauthSource.toLowerCase() as OAuthSource)
    : await chooseOAuthSource();
  const registry = new RegistryManager();

  if (source === 'keychain') {
    await importCurrentAntigravityAccount(options, services, registry);
    return;
  }

  if (source === 'antigravity') {
    await signInThroughAntigravity(options, services, registry);
    return;
  }

  await signInWithBrowser(options, services, registry);
}
