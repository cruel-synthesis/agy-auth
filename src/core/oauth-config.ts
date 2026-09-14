export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
}

/**
 * The OAuth client Antigravity signs in with, published in its own binary.
 *
 * Google binds a refresh token to the client that issued it, so a session
 * imported from Antigravity can be renewed by this client and by no other.
 * agy-auth uses it for exactly that and nothing else: it never signs a new
 * account in with it, so it never creates a session Antigravity did not.
 * `login` still requires a client of the user's own.
 *
 * Installed applications cannot keep a secret (RFC 8252 section 8.5), which is
 * why this pair ships in a binary anyone can read rather than being withheld.
 */
export const ANTIGRAVITY_OAUTH_CLIENT: OAuthClientConfig = {
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: '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',
};

/**
 * The client used to sign in a new account, supplied entirely by the
 * environment. agy-auth ships none: redistributing a third-party client ID for
 * sign-in would make every user of this tool impersonate an application they
 * never registered. Without `AGY_OAUTH_CLIENT_ID`, `login` is unavailable.
 */
export function getOAuthClientConfig(
  env: NodeJS.ProcessEnv = process.env
): OAuthClientConfig | null {
  const clientId = env.AGY_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return null;

  const clientSecret = env.AGY_OAUTH_CLIENT_SECRET?.trim();
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

export const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
