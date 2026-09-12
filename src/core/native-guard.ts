/**
 * Guard for operations that escape process-local redirection.
 *
 * Redirecting `HOME` and the `AGY_*` path variables isolates files only. Native
 * credential stores, browsers and desktop applications ignore those variables
 * entirely, so a code path reached without an explicit test double would touch
 * the developer's real Keychain, browser or IDE.
 *
 * Test environments set `AGY_AUTH_NO_NATIVE=1`, which makes every such operation
 * fail immediately and visibly. The variable is exported to subprocesses too, so
 * a spawned CLI is held to the same rule as the test runner.
 */
export function assertNativeAllowed(operation: string): void {
  if (process.env.AGY_AUTH_NO_NATIVE !== '1') return;

  throw new Error(
    `Blocked native operation '${operation}' in an isolated environment. ` +
      'Install an explicit test double for it; redirecting HOME does not isolate ' +
      'native credential stores or application launchers.'
  );
}
