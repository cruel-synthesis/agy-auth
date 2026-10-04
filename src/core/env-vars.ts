import path from 'node:path';
import { Paths } from './paths.js';
import { Account } from './types.js';

/** The variables `agy-auth env` owns: it sets these or unsets them, nothing else. */
export const MANAGED_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
];

/**
 * What the shell should hold for this account. A `null` means unset.
 *
 * Pass `null` for the account to clear every managed variable.
 */
export function environmentFor(account: Account | null): Record<string, string | null> {
  const env: Record<string, string | null> = Object.fromEntries(
    MANAGED_ENV_VARS.map((name) => [name, null])
  );
  if (!account) return env;

  if (account.gcpProject) env.GOOGLE_CLOUD_PROJECT = account.gcpProject;
  if (account.gcpLocation) env.GOOGLE_CLOUD_LOCATION = account.gcpLocation;

  if (account.authType === 'api-key' && account.credentials?.apiKey) {
    env.GEMINI_API_KEY = account.credentials.apiKey;
    env.GOOGLE_API_KEY = account.credentials.apiKey;
  }

  if (account.authType === 'service-account' && account.credentials?.serviceAccountKey) {
    env.GOOGLE_APPLICATION_CREDENTIALS = path.join(
      Paths.accountsDir,
      `${path.basename(account.id)}.json`
    );
  }

  return env;
}

/**
 * Whether the shell has anything to apply when moving between these accounts.
 *
 * A plain Antigravity OAuth account sets no variable, so switching between two
 * of them changes nothing a shell can see and there is nothing to tell the user
 * to run.
 */
export function shellEnvChanges(from: Account | null, to: Account | null): boolean {
  const before = environmentFor(from);
  const after = environmentFor(to);
  return MANAGED_ENV_VARS.some((name) => before[name] !== after[name]);
}

/**
 * The line that loads `agy-auth env` into the current shell. It follows env's
 * default format, which is PowerShell on Windows, where `eval` does not exist.
 */
export function applyEnvCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'agy-auth env | Out-String | Invoke-Expression'
    : 'eval "$(agy-auth env)"';
}
