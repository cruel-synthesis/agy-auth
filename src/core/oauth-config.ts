export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
}

/**
 * OAuth client configuration is supplied entirely by the environment.
 *
 * agy-auth ships neither a client ID nor a client secret. Embedding a secret in
 * a public package publishes it, and redistributing a third-party client ID
 * would make every user of this tool impersonate an application they never
 * registered. Without `AGY_OAUTH_CLIENT_ID` the tool cannot mint a new access
 * token and reports the profile as expired instead.
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
