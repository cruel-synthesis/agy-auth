/**
 * Hermetic transport guard.
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
