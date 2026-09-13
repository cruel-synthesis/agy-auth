/**
 * Hermetic environment for spawned processes.
 *
 * `tests/setup-hermetic.ts` only covers the test runner. A CLI launched as a
 * child process starts a fresh Node runtime with a real `fetch` and, unless the
 * parent remembered to pass it down, no native-store guard. Loading this module
 * with `node --import` holds the child to both rules itself, so protection does
 * not depend on an inherited environment alone.
 */
globalThis.fetch = () => {
  throw new Error(
    'Tests must not perform real network requests. Inject a fetch double via options.fetchFn.'
  );
};

process.env.AGY_AUTH_NO_NATIVE = '1';
