# Changelog

All notable changes to `@cruel-synthesis/agy-auth` will be documented in this file.

## 0.1.0 - Unreleased

First release.

### Added

- Accounts for OAuth, API keys, service-account JSON, and Application Default Credentials.
- Direct Antigravity session import from Apple Keychain or the token file, with identity verification and no required client ID.
- Browser OAuth 2.0 PKCE onboarding via `agy-auth login`, and in-place renewal of stored tokens.
- Journaled account switching with rollback for Antigravity settings, session stores, service-account files, and ADC.
- Experimental live plan and quota reporting for OAuth accounts, with bounded requests, cached fallback, and offline mode.
- `agy-auth auto` (alias `best`) ranks accounts by how much quota would otherwise go to waste and switches to the best one. `--dry-run` shows the ranking without switching; `--watch` stays in the terminal and switches when the account in use runs out.
- A responsive account table shared by `list` and the interactive picker, with Unicode-safe column widths.
- Versioned JSON output and exit codes for automation.
- Export, import, migration, diagnostics, and account configuration commands.

### Security

- Credentials are stored under restricted POSIX modes, redacted from account and status output, and read only through no-follow descriptors that reject symlinked, replaced, non-regular, or oversized paths.
- Registry mutations are locked across processes, validated fail-closed, and rolled back when a switch cannot complete.
- Sign-in and renewal use the OAuth client Antigravity publishes in its own binary, the only one Google's individual tier answers; `AGY_OAUTH_CLIENT_ID` selects your own. See [SECURITY.md](./SECURITY.md).
- The loopback OAuth callback binds to `127.0.0.1`, validates PKCE and state, and settles exactly once.
- No telemetry and no background process. [PRIVACY.md](./PRIVACY.md) lists the scopes sign-in requests and every host contacted.

### Compatibility

- Registry schema version 3, with automatic migration from schema 2. Any other schema version is refused with the registry left as it was found.
- Node.js 22 or later.
