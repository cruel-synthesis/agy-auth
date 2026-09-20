import { Account } from './types.js';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
}

/**
 * The OAuth client Antigravity signs in with, published in its own binary.
 *
 * Google's individual tier answers this client and refuses every other, telling
 * the rest that the tier "is no longer supported" and denying them quota, so an
 * account signed in under a client of your own registers and then reports
 * nothing for as long as you keep it. agy-auth therefore signs in and renews
 * with this one.
 *
 * Installed applications cannot keep a secret (RFC 8252 section 8.5), which is
 * why this pair ships in a binary anyone can read rather than being withheld.
 */
export const ANTIGRAVITY_OAUTH_CLIENT: OAuthClientConfig = {
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: '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',
};

/**
 * A client of your own, when `AGY_OAUTH_CLIENT_ID` names one. Null otherwise,
 * which is the ordinary case.
 */
export function getOAuthClientConfig(
  env: NodeJS.ProcessEnv = process.env
): OAuthClientConfig | null {
  const clientId = env.AGY_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return null;

  const clientSecret = env.AGY_OAUTH_CLIENT_SECRET?.trim();
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

/** The client browser sign-in uses: your own when configured, Antigravity's otherwise. */
export function getSignInClient(env: NodeJS.ProcessEnv = process.env): OAuthClientConfig {
  return getOAuthClientConfig(env) ?? ANTIGRAVITY_OAUTH_CLIENT;
}

export const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * The refresh token already stored for this account, when the client now
 * signing in is the one that issued it. Empty string when it is not.
 *
 * Google honours a refresh token only for its own client, so one issued to a
 * different client is not carried across. An account of unrecorded origin is
 * treated as Antigravity's: the only way to hold a session payload was the
 * Antigravity import, and offering a refresh token to the wrong client is
 * refused without consequence, whereas discarding it strands the account with
 * nothing to renew from.
 */
export function reusableRefreshToken(
  existing: Account | undefined,
  signInClientId: string
): string {
  if (!existing) return '';

  const sameClient =
    signInClientId === ANTIGRAVITY_OAUTH_CLIENT.clientId
      ? existing.credentialSource !== 'custom-client'
      : existing.credentialSource === 'custom-client' &&
        (!existing.oauthClientId || existing.oauthClientId === signInClientId);

  return sameClient ? existing.credentials?.keychainPayload?.token?.refresh_token || '' : '';
}
