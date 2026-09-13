import { UsageError } from '../core/errors.js';
import type { AgyKeychainPayload } from '../core/keychain.js';
import { getOAuthClientConfig } from '../core/oauth-config.js';
import { type AuthenticateOptions, OAuthFlow, type OAuthResult } from '../core/oauth.js';
import { RegistryManager } from '../core/registry.js';
import type { Account } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';

const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface LoginOptions {
  alias?: string;
  project?: string;
  location?: string;
  model?: string;
}

export interface LoginServices {
  authenticateOAuth?: (options?: AuthenticateOptions) => Promise<OAuthResult>;
  fetchFn?: typeof fetch;
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

/**
 * Browser sign-in with the user's own OAuth client. Importing the account
 * Antigravity is already signed in to is `agy-auth add`; this command exists
 * for the accounts Antigravity does not hold.
 */
export async function loginCommand(
  options: LoginOptions = {},
  services?: LoginServices
): Promise<void> {
  if (options.alias !== undefined) {
    const valid = validateAliasInput(options.alias);
    if (typeof valid === 'string') {
      throw new UsageError(`Invalid alias "${options.alias}": ${valid}`);
    }
  }

  const registry = new RegistryManager();
  const authenticate = services?.authenticateOAuth || OAuthFlow.authenticate;
  const result = await authenticate({ fetchFn: services?.fetchFn });
  const normalizedEmail = result.email.toLowerCase();
  const existing = registry
    .getAccounts()
    .find(
      (account) => account.authType === 'oauth' && account.email.toLowerCase() === normalizedEmail
    );

  const configuredClient = getOAuthClientConfig();
  // Only a refresh token this same client issued can be reused here.
  const reusableRefreshToken =
    existing &&
    existing.credentialSource === 'custom-client' &&
    (!existing.oauthClientId || existing.oauthClientId === configuredClient?.clientId)
      ? existing.credentials?.keychainPayload?.token?.refresh_token || ''
      : '';

  const refreshToken = result.payload.token.refresh_token || reusableRefreshToken || '';
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
    credentialSource: 'custom-client',
    oauthClientId: configuredClient?.clientId,
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
