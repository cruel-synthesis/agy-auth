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

These variables do not redirect the macOS Keychain. Do not run OAuth `sync` or `switch` against a real Keychain item during development; use the automated test harness and synthetic fixtures for those paths.

Never commit registry files, exports, `.env` files, OAuth payloads, API keys, service-account JSON, ADC files, or logs containing those values. Examples and fixtures must use generated or unmistakably fake credentials.

Public behavior changes should update the relevant file under `docs/commands/` and the changelog. Security reports belong in a private advisory, as described in [SECURITY.md](./SECURITY.md).
