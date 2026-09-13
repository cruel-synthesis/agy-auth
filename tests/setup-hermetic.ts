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
