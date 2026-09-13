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
 *
 * The dedicated error type exists so that a caller which tolerates a native
 * operation failing can still let an isolation breach through instead of
 * quietly swallowing it.
 */
export class NativeOperationBlockedError extends Error {}

/**
 * Latched once the variable has been seen set, so blocking is one-way within a
 * process: code that later changes or deletes the variable cannot reopen native
 * access for the rest of the run.
 */
let blocked = false;

export function assertNativeAllowed(operation: string): void {
  blocked ||= process.env.AGY_AUTH_NO_NATIVE === '1';
  if (!blocked) return;

  throw new NativeOperationBlockedError(
    `Blocked native operation '${operation}' in an isolated environment. ` +
      'Install an explicit test double for it; redirecting HOME does not isolate ' +
      'native credential stores or application launchers.'
  );
}
