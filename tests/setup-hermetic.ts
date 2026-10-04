import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Hermetic environment for the normal suite: no network, no native stores.
 *
 * Vitest loads this before every test file, so neither guard below can be
 * skipped by a file that forgets to opt in.
 *
 * Every production code path that talks to the network accepts an injected
 * `fetch`. Replacing the global one makes an accidental real request fail loudly
 * instead of silently reaching Google from the test suite.
 */
const blocked = (): never => {
  throw new Error(
    'Tests must not perform real network requests. Inject a fetch double via options.fetchFn.'
  );
};

globalThis.fetch = blocked as unknown as typeof fetch;

/**
 * Native-store guard, applied to the whole run.
 *
 * `setupTestEnvironment()` also sets this, but a test file that does not call it
 * would otherwise be free to reach the real Keychain, browser or IDE. Setting it
 * here means no test file can opt out by omission, and no test may unset it.
 */
process.env.AGY_AUTH_NO_NATIVE = '1';

/**
 * Home-directory guard. Every store path defaults to one under the home
 * directory, or to an override inherited from the shell. A test file that does
 * not call `setupTestEnvironment()` must still resolve them into scratch space,
 * never into the developer's own agy-auth, Antigravity or gcloud files.
 */
const scratchHome =
  process.env.AGY_TEST_SCRATCH_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hermetic-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.APPDATA = path.join(scratchHome, 'AppData', 'Roaming');
for (const key of [
  'AGY_AUTH_HOME',
  'AGY_CLI_DIR',
  'AGY_SETTINGS_FILE',
  'AGY_TOKEN_FILE',
  'AGY_GCLOUD_ADC_FILE',
]) {
  delete process.env[key];
}

/**
 * Plain output everywhere. picocolors turns color on whenever `CI` is set or the
 * platform is Windows, so assertions on rendered text would otherwise pass
 * locally and fail on every CI runner.
 */
process.env.NO_COLOR = '1';
