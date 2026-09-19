import { readAntigravityToken } from './antigravity-store.js';
import { isEmail } from './credential-validation.js';
import { Discovery } from './discovery.js';
import { CliError, UsageError } from './errors.js';
import { ANTIGRAVITY_OAUTH_CLIENT, reusableRefreshToken } from './oauth-config.js';
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
      /** Why the identity is unknown: no answer at all, or a definite "not verified". */
      reason: 'unavailable' | 'unverified_identity';
      payload: KeychainPayload;
      defaultProject?: string;
      defaultLocation?: string;
      defaultModel?: string;
    };

/**
 * The four distinguishable answers Google can give about a session.
 *
 * Collapsing them loses the difference between "this token is dead" and "we
 * could not ask right now", which decides whether it is safe to write anything.
 */
export type GoogleIdentityOutcome =
  | { kind: 'verified'; email: string }
  | { kind: 'unverified'; email: string }
  | { kind: 'rejected'; status: number }
  | { kind: 'unavailable'; reason: string };

/**
 * Asks Google's userinfo endpoint who a given access token belongs to.
 * Does not require an OAuth client ID or client secret.
 */
export async function fetchGoogleIdentity(
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<GoogleIdentityOutcome> {
  let res: Response;
  try {
    res = await fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error: unknown) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // 401/403 are decisive: the credential itself was refused.
  if (res.status === 401 || res.status === 403) {
    return { kind: 'rejected', status: res.status };
  }
  if (!res.ok) {
    return { kind: 'unavailable', reason: `userinfo responded with HTTP ${res.status}` };
  }

  let data: { email?: string; email_verified?: boolean };
  try {
    data = (await res.json()) as { email?: string; email_verified?: boolean };
  } catch {
    return { kind: 'unavailable', reason: 'userinfo returned a malformed response body' };
  }

  const email = typeof data.email === 'string' ? data.email.trim() : '';
  if (!isEmail(email)) {
    return { kind: 'unavailable', reason: 'userinfo returned no usable email address' };
  }

  return data.email_verified === true ? { kind: 'verified', email } : { kind: 'unverified', email };
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
      "No Antigravity token-file session was found. This platform's native OS keyring is not supported by agy-auth; configure AGY_OAUTH_CLIENT_ID and run `agy-auth login` instead.",
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

  const identity: GoogleIdentityOutcome = accessToken
    ? await fetchGoogleIdentity(accessToken, fetchFn)
    : { kind: 'unavailable', reason: 'the session carries no access token' };

  if (identity.kind === 'rejected') {
    throw new CliError(
      `Google rejected the active Antigravity session (HTTP ${identity.status}). ` +
        'Sign in again in Antigravity, then rerun this command.',
      'session_rejected',
      1,
      { status: identity.status }
    );
  }

  const liveEmail = identity.kind === 'unavailable' ? null : identity.email;
  const emailVerified = identity.kind === 'verified';

  let finalEmail: string | undefined;
  let isDerived = false;
  let isVerified = false;

  if (options.email) {
    const trimmed = options.email.trim();
    if (!isEmail(trimmed)) {
      throw new UsageError(`Invalid OAuth email address '${options.email}'.`);
    }
    // Google's answer is authoritative. A supplied email that contradicts it
    // would file this session under the wrong profile, so stop before any write.
    if (liveEmail && liveEmail.toLowerCase() !== trimmed.toLowerCase()) {
      throw new CliError(
        `The active Antigravity session belongs to ${liveEmail}, not ${trimmed}. ` +
          'Rerun without --email to save the signed-in account, or sign in as ' +
          `${trimmed} in Antigravity first.`,
        'identity_mismatch',
        1,
        { supplied: trimmed, verified: liveEmail }
      );
    }
    finalEmail = trimmed;
    isVerified = Boolean(liveEmail) && emailVerified;
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
      reason: identity.kind === 'unverified' ? 'unverified_identity' : 'unavailable',
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

  // A native session is always Antigravity's own client.
  const refreshToken =
    payload.token.refresh_token ||
    reusableRefreshToken(existing, ANTIGRAVITY_OAUTH_CLIENT.clientId);

  const mergedPayload: KeychainPayload = {
    auth_method: payload.auth_method || 'consumer',
    token: {
      access_token: payload.token.access_token,
      token_type: payload.token.token_type || 'Bearer',
      refresh_token: refreshToken,
      expiry: payload.token.expiry,
    },
  };

  if (existing && !isVerified) {
    const stored = existing.credentials?.keychainPayload;
    const unchanged =
      stored?.token?.access_token === mergedPayload.token.access_token &&
      stored?.token?.refresh_token === mergedPayload.token.refresh_token &&
      stored?.token?.expiry === mergedPayload.token.expiry;

    // Re-importing the very same session changes nothing, so let it through.
    // Anything else would file an unattributable session under this profile and
    // leave the account's earlier 'valid' verdict standing over new credentials.
    if (!unchanged) {
      const cause =
        identity.kind === 'unavailable'
          ? `identity check unavailable: ${identity.reason}`
          : 'Google reports the address as unverified';

      throw new CliError(
        `Could not confirm that the active Antigravity session belongs to ${finalEmail}, ` +
          `so the saved account was left unchanged (${cause}). ` +
          'Retry when the identity can be checked.',
        'verification_required',
        1,
        { email: finalEmail, reason: identity.kind }
      );
    }

    return {
      status: 'success',
      account: existing,
      isNew: false,
      derivedEmail: isDerived,
      verifiedEmail: false,
    };
  }

  const status = isVerified ? 'valid' : 'unverified';
  const verification = isVerified ? { checkedAt: Date.now(), source: 'userinfo' } : undefined;

  const account = registry.addOrUpdateAccount({
    email: finalEmail,
    alias: options.alias !== undefined ? options.alias.trim() || undefined : existing?.alias,
    authType: 'oauth',
    // This session came out of the Antigravity store, so Antigravity issued it.
    credentialSource: 'antigravity',
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
