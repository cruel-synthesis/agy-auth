# Contributing

Use Node.js 22 or 24 and install the locked dependency graph:

```shell
npm ci
```

Before opening a pull request, run:

```shell
npm run check
npm pack --dry-run
```

Keep changes scoped to one behavior or subsystem. Add regression tests for bug fixes and tests at the public boundary for new behavior. Do not weaken an assertion to make a failing change pass.

Use temporary paths during manual tests so file-backed state stays separate from your real configuration:

```shell
agy_test_root="$(mktemp -d)"
export AGY_AUTH_HOME="${agy_test_root}/.agy-auth"
export AGY_CLI_DIR="${agy_test_root}/.gemini/antigravity-cli"
export AGY_SETTINGS_FILE="${AGY_CLI_DIR}/settings.json"
export AGY_GCLOUD_ADC_FILE="${agy_test_root}/.config/gcloud/application_default_credentials.json"
npm run build
node ./bin/agy-auth.js --help
```

These variables do not redirect the macOS Keychain. Do not run OAuth `login` or `switch` against a real Keychain item during development; use the automated test harness and synthetic fixtures for those paths.

The test suite blocks native credential stores, browsers and application launches outright: `tests/setup-hermetic.ts` sets `AGY_AUTH_NO_NATIVE=1` for every test file, and `tests/subprocess-guard.mjs` sets it again inside any CLI spawned by a test. No test may unset it, and a spawned CLI must be launched through `guardedNodeArgs()`. Blocking is one-way within a process: once the guard has been seen set, deleting or changing the variable afterwards does not reopen native access. Install an explicit double for the operation instead.

Keep each native operation behind a single function that calls `assertNativeAllowed()` immediately before the real call, and execute a credential-store binary from that one place only. A caller that tolerates the operation failing must re-throw `NativeOperationBlockedError` rather than swallow it with everything else. A test in `tests/native-isolation.test.ts` flags a second credential-store call whose executable is written inline as a string literal, which is the shape this rule has been broken in before; it is a text match rather than static analysis, so it backs the rule up and does not replace it.

Verifying a credential store end to end means writing to one. Do that on a disposable machine or runner with no personal accounts, never on a development machine. A change that reads back what it wrote, or otherwise depends on real stored state, needs that verification before it can be merged.

Never commit registry files, exports, `.env` files, OAuth payloads, API keys, service-account JSON, ADC files, or logs containing those values. Examples and fixtures must use generated or unmistakably fake credentials.

Public behavior changes should update the relevant file under `docs/commands/` and the changelog. Security reports belong in a private advisory, as described in [SECURITY.md](./SECURITY.md).
