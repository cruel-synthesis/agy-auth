/**
 * Refuses to run the live lane unless it was requested explicitly, so a stray
 * `vitest --config vitest.live.config.ts` cannot reach a real account by
 * accident.
 */
export function setup(): void {
  if (process.env.AGY_AUTH_LIVE !== '1') {
    throw new Error(
      'Live-account tests are opt-in. Set AGY_AUTH_LIVE=1 to run them against real credentials.'
    );
  }
}
