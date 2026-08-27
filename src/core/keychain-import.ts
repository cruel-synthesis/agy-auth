import { readAntigravityToken } from './antigravity-store.js';
import { isEmail } from './credential-validation.js';
import { Discovery } from './discovery.js';
import { CliError, UsageError } from './errors.js';
import { RegistryManager } from './registry.js';
import type { Account, KeychainPayload } from './types.js';

export interface ImportKeychainOAuthOptions {
  email?: string;
  alias?: string;
  project?: string;
  location?: string;
  model?: string;
  fetchFn?: typeof fetch;
  registry?: RegistryManager;
}

export type ImportKeychainOAuthResult =
  | {
      status: 'success';
      account: Account;
      isNew: boolean;
      derivedEmail: boolean;
      verifiedEmail: boolean;
    }
  | {
      status: 'needs_email';
      payload: KeychainPayload;
      defaultProject?: string;
      defaultLocation?: string;
      defaultModel?: string;
    };

/**
 * Derives and verifies the account email from Google's userinfo endpoint using the access token.
 * Does not require an OAuth client ID or client secret.
 */
export async function fetchVerifiedGoogleEmail(
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<{ email: string; verified: boolean } | null> {
  try {
    const res = await fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string; email_verified?: boolean };
    if (typeof data.email === 'string' && isEmail(data.email.trim())) {
      return {
        email: data.email.trim(),
        verified: data.email_verified === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Imports an active Antigravity session from the composite token store into the local registry.
 * Safely preserves existing refresh tokens and stable metadata without mutating external state.
 */
export async function importKeychainOAuth(
  options: ImportKeychainOAuthOptions = {}
): Promise<ImportKeychainOAuthResult> {
  const tokenState = readAntigravityToken();
  if (tokenState.status === 'unsupported') {
    throw new CliError(
      'Antigravity OAuth Keychain integration is only supported on macOS.',
      'unsupported_platform',
      1
    );
  }
  if (tokenState.status === 'missing') {
    throw new CliError(
      'No active Antigravity sign-in was found. Sign in through Antigravity, then rerun this command.',
      'not_found',
      1
    );
  }
  if (tokenState.status === 'error' || !tokenState.payload) {
    throw new CliError(
      `Antigravity session store read error: ${tokenState.warning || 'Failed to read token payload.'}`,
      'session_store_error',
      1
    );
  }

  const payload = tokenState.payload;
  const accessToken = payload.token.access_token;
  const fetchFn = options.fetchFn || fetch;

  let liveEmail: string | null = null;
  let emailVerified = false;

  if (accessToken) {
    const liveResult = await fetchVerifiedGoogleEmail(accessToken, fetchFn);
    if (liveResult) {
      liveEmail = liveResult.email;
      emailVerified = liveResult.verified;
    }
  }

  let finalEmail: string | undefined;
  let isDerived = false;
  let isVerified = false;

  if (options.email) {
    const trimmed = options.email.trim();
    if (!isEmail(trimmed)) {
      throw new UsageError(`Invalid OAuth email address '${options.email}'.`);
    }
    finalEmail = trimmed;
    if (liveEmail && liveEmail.toLowerCase() === trimmed.toLowerCase() && emailVerified) {
      isVerified = true;
    } else {
      isVerified = false;
    }
  } else if (liveEmail && emailVerified) {
    finalEmail = liveEmail;
    isDerived = true;
    isVerified = true;
  }

  const settings = Discovery.readAntigravitySettings();
  const defaultProject = settings?.gcp?.project;
  const defaultLocation = settings?.gcp?.location;
  const defaultModel = settings?.model;

  if (!finalEmail) {
    return {
      status: 'needs_email',
      payload,
      defaultProject,
      defaultLocation,
      defaultModel,
    };
  }

  const registry = options.registry || new RegistryManager();
  const accounts = registry.getAccounts();
  const existing = accounts.find(
    (a) => a.authType === 'oauth' && a.email.toLowerCase() === finalEmail.toLowerCase()
  );

  const existingRefreshToken = existing?.credentials?.keychainPayload?.token?.refresh_token || '';

  const refreshToken = payload.token.refresh_token || existingRefreshToken || '';

  const mergedPayload: KeychainPayload = {
    auth_method: payload.auth_method || 'consumer',
    token: {
      access_token: payload.token.access_token,
      token_type: payload.token.token_type || 'Bearer',
      refresh_token: refreshToken,
      expiry: payload.token.expiry,
    },
  };

  const status = isVerified ? 'valid' : existing?.status || 'unverified';
  const verification = isVerified
    ? { checkedAt: Date.now(), source: 'userinfo' }
    : existing?.verification;

  const account = registry.addOrUpdateAccount({
    email: finalEmail,
    alias: options.alias !== undefined ? options.alias.trim() || undefined : existing?.alias,
    authType: 'oauth',
    status,
    verification,
    gcpProject:
      options.project !== undefined
        ? options.project.trim() || undefined
        : existing?.gcpProject || defaultProject,
    gcpLocation:
      options.location !== undefined
        ? options.location.trim() || undefined
        : existing?.gcpLocation || defaultLocation,
    model:
      options.model !== undefined
        ? options.model.trim() || undefined
        : existing?.model || defaultModel,
    credentials: {
      keychainPayload: mergedPayload,
    },
  });

  return {
    status: 'success',
    account,
    isNew: !existing,
    derivedEmail: isDerived,
    verifiedEmail: isVerified,
  };
}
