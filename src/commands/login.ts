import type { AgyKeychainPayload } from '../core/keychain.js';
import {
  ANTIGRAVITY_OAUTH_CLIENT,
  getSignInClient,
  reusableRefreshToken,
} from '../core/oauth-config.js';
import { type AuthenticateOptions, OAuthFlow, type OAuthResult } from '../core/oauth.js';
import { RegistryManager } from '../core/registry.js';
import { type Account, checkAlias, checkInputLength } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors, marks } from '../ui/theme.js';

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

function printSavedAccount(account: Account, isNew: boolean, isActive: boolean): void {
  const action = isNew ? 'Account added successfully' : 'Account updated successfully';
  console.log(`\n  ${marks.ok} ${action}: ${colors.green(formatAccountShort(account))}`);
  if (isActive) {
    console.log('  It is the account in use.\n');
    return;
  }
  console.log(
    `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
  );
}

/**
 * Browser sign-in, with Antigravity's OAuth client unless AGY_OAUTH_CLIENT_ID
 * names another. Importing the account
 * Antigravity is already signed in to is `agy-auth add`; this command exists
 * for the accounts Antigravity does not hold.
 */
export async function loginCommand(
  options: LoginOptions = {},
  services?: LoginServices
): Promise<void> {
  if (options.alias?.trim()) checkAlias(options.alias.trim());
  // Checked before the browser sign-in, which would otherwise be wasted.
  checkInputLength('gcpProject', options.project?.trim(), '--project');
  checkInputLength('gcpLocation', options.location?.trim(), '--location');
  checkInputLength('model', options.model?.trim(), '--model');

  const registry = new RegistryManager();
  const authenticate = services?.authenticateOAuth || OAuthFlow.authenticate;
  const result = await authenticate({ fetchFn: services?.fetchFn });
  const normalizedEmail = result.email.toLowerCase();
  const existing = registry
    .getAccounts()
    .find(
      (account) => account.authType === 'oauth' && account.email.toLowerCase() === normalizedEmail
    );

  const client = getSignInClient();
  const source =
    client.clientId === ANTIGRAVITY_OAUTH_CLIENT.clientId ? 'antigravity' : 'custom-client';

  const refreshToken =
    result.payload.token.refresh_token || reusableRefreshToken(existing, client.clientId);
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
    credentialSource: source,
    ...(source === 'custom-client' ? { oauthClientId: client.clientId } : {}),
    status: 'valid',
    gcpProject:
      options.project !== undefined ? options.project.trim() || undefined : existing?.gcpProject,
    gcpLocation:
      options.location !== undefined ? options.location.trim() || undefined : existing?.gcpLocation,
    model: options.model !== undefined ? options.model.trim() || undefined : existing?.model,
    credentials: { keychainPayload: payload },
  });

  printSavedAccount(account, !existing, registry.getActiveAccount()?.id === account.id);
}
