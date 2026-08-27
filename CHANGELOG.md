# Changelog

All notable changes to `@cruel-synthesis/agy-auth` will be documented in this file.

## 0.1.0 - 2026-08-23

### Added

- Credential profiles for OAuth, API keys, service-account JSON, and Application Default Credentials.
- Direct Antigravity macOS Keychain session import and identity verification (default out-of-box OAuth flow without client ID).
- Browser OAuth 2.0 PKCE onboarding (`--oauth-source browser`) and in-place profile refreshing with user-supplied client configuration.
- Journaled profile switching with rollback attempts for Antigravity settings, service-account files, ADC, and macOS Keychain state.
- Experimental live plan and quota reporting for OAuth profiles, with bounded requests, cached fallback, and offline mode.
- A responsive account table shared by `list` and the interactive picker, including Unicode-safe width handling.
- Versioned JSON output and exit codes for automation.
- Export, import, migration, diagnostics, and profile configuration commands.

### Fixed

- Explicit `login --oauth-source keychain|browser` now enters the requested OAuth flow directly.

### Security

- Restricted POSIX file modes, registry locking, symlink rejection, credential-file size limits, and credential redaction in profile and status output.
- No embedded OAuth client credentials, telemetry, or background process.
- Local loopback OAuth callback server strictly bound to 127.0.0.1 with PKCE and state validation.

### Compatibility

- Registry schema version 2 with automatic migration from version 1.
- Node.js 22 or later.
