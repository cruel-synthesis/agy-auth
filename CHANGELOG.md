# Changelog

All notable changes to `@cruel-synthesis/agy-auth` will be documented in this file.

## 0.1.0 - 2026-08-23

### Added

- Credential profiles for OAuth, API keys, service-account JSON, and Application Default Credentials.
- Direct Antigravity session import from Apple Keychain or the token file, with identity verification and no required client ID.
- Browser OAuth 2.0 PKCE onboarding (`--oauth-source browser`) and in-place profile refreshing with user-supplied client configuration.
- Journaled profile switching with rollback attempts for Antigravity settings, session stores, service-account files, and ADC.
- Experimental live plan and quota reporting for OAuth profiles, with bounded requests, cached fallback, and offline mode.
- A responsive account table shared by `list` and the interactive picker, including Unicode-safe width handling.
- Versioned JSON output and exit codes for automation.
- Export, import, migration, diagnostics, and profile configuration commands.

### Fixed

- Explicit `login --oauth-source keychain|browser` now enters the requested OAuth flow directly.
- Login errors now reference only supported command-line options.
- Interactive `login` is limited to Google OAuth; non-OAuth credentials remain under `add`.
- On macOS, interactive login hands new-account sign-in to Antigravity and imports the resulting session instead of offering an unconfigured browser flow.
- `add --api-key` supports masked TTY entry when the key value is omitted.
- OAuth switching now aborts when the existing Keychain item cannot be snapshotted and reports failed Keychain rollback operations.
- `remove` rejects selectors combined with `--all` instead of silently deleting every profile.
- The machine-readable interface documentation now includes `sync --json`.
- Composite Antigravity session failures use the accurate `session_store_error` code and wording.
- Interactive login detects file-backed Antigravity sessions on every platform and never offers an unconfigured browser flow.
- Browser OAuth processes only one valid loopback callback and ignores concurrent duplicates.

### Security

- Restricted POSIX file modes, registry locking, symlink rejection, credential-file size limits, and credential redaction in profile and status output.
- Fail-closed validation rejects malformed OAuth payloads from both Keychain and the Antigravity token file.
- Antigravity token-file reads reject symlinked and non-regular paths.
- Antigravity token-file reads use no-follow descriptor validation so a path swap cannot bypass symlink rejection.
- Antigravity token-file reads reject files larger than the 1 MiB credential limit.
- Registry reads use no-follow descriptor validation so a path swap cannot bypass symlink rejection.
- `doctor` uses no-follow descriptor validation when checking the registry.
- Managed backups use no-follow descriptor validation and reject replaced source paths.
- Account switching aborts and rolls back if Antigravity settings change after their snapshot.
- Antigravity settings discovery uses no-follow descriptor validation and ignores swapped paths.
- `doctor` uses no-follow descriptor validation when checking Antigravity settings.
- OAuth token switch backups are classified as managed secrets, so retention and `clean` apply to them.
- `doctor` warns when either half of the Antigravity session store fails but the other remains usable.
- `doctor` rejects a symlinked or non-regular Antigravity settings path.
- OAuth profile discovery ignores a symlinked or non-regular Antigravity settings path.
- No embedded OAuth client credentials, telemetry, or background process.
- Local loopback OAuth callback server strictly bound to 127.0.0.1 with PKCE and state validation.

### Compatibility

- Registry schema version 2 with automatic migration from version 1.
- Node.js 22 or later.
