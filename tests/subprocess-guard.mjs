/**
 * Hermetic transport guard for spawned processes.
 *
 * `tests/setup-no-network.ts` only covers the test runner. A CLI launched as a
 * child process starts a fresh Node runtime with a real `fetch`, so integration
 * tests could reach the network unnoticed. Loading this module with
 * `node --import` holds the child to the same rule as the runner.
 */
globalThis.fetch = () => {
  throw new Error(
    'Tests must not perform real network requests. Inject a fetch double via options.fetchFn.'
  );
};
