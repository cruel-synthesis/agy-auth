# Security Policy

## Supported Versions

Until the project reaches 1.0, security fixes are applied to the latest published 0.x release and the current default branch (`main`).

## Reporting a Vulnerability

Please use [GitHub Private Vulnerability Reporting](https://github.com/cruel-synthesis/agy-auth/security/advisories/new). Do not open public issues for security vulnerabilities involving credentials or privilege escalation. Never include real API keys, OAuth tokens, service-account private keys, ADC files, or secret-bearing exports in any report.

Please provide:
1. Affected version and Node.js version
2. Operating system and platform architecture
3. Detailed reproduction steps using synthetic/mock credentials
4. Observed vs expected security behavior

## Security Boundary & Threat Model

`agy-auth` manages local credentials for the current user:
- On POSIX systems, storage directories (`~/.agy-auth/`) are created with mode `0700` (`rwx------`).
- On POSIX systems, registry and credential files are created with mode `0600` (`rw-------`). Windows protection depends on the user's filesystem ACLs because POSIX mode bits are not enforced there.
- Registry and switch mutations use lock files to serialize concurrent `agy-auth` processes.
- Credential file readers strictly reject symlinks, irregular files, and files exceeding size limits (1 MiB for credentials, 5 MiB for imports).
- Profile and status JSON redact credentials. `agy-auth env` deliberately emits shell values and its JSON form is marked `containsSecrets`; `agy-auth export --include-secrets` deliberately writes credentials to a file.
- Managed recovery snapshots can contain a pre-mutation registry, ADC file, service-account key, or Antigravity settings. `agy-auth clean --all` deletes all managed snapshots.

## Network Boundary

`agy-auth` signs in and renews tokens with **the OAuth client published in Antigravity's own binary** (`src/core/oauth-config.ts`). Google's individual tier answers that client and refuses others, so a client of your own registers and then reports no quota. An installed application cannot keep a secret (RFC 8252 section 8.5), which is why that pair ships readable in Antigravity's binary and here alike: it identifies the application, never you. Set `AGY_OAUTH_CLIENT_ID` (and `AGY_OAUTH_CLIENT_SECRET` if your client requires one) to use your own instead.

`agy-auth` performs no telemetry and installs no daemon. `agy-auth auto --watch` polls only while you leave it running in your terminal.

Outbound requests are limited to:

| Host | Purpose | When |
|---|---|---|
| `accounts.google.com` | Browser OAuth user sign-in via PKCE | `agy-auth login --oauth-source browser` |
| `oauth2.googleapis.com` | Authorization code and refresh-token exchange | During browser OAuth login, and whenever a stored token needs renewing before a quota reading |
| `www.googleapis.com` | Verified userinfo lookup (`/oauth2/v3/userinfo`) | During Antigravity session import and browser OAuth login |
| `daily-cloudcode-pa.googleapis.com`, `cloudcode-pa.googleapis.com` | Live plan and quota via the undocumented `v1internal:retrieveUserQuotaSummary`, `v1internal:loadCodeAssist`, and `v1internal:retrieveUserQuota` contracts (**experimental**) | `list`, `list --check`, `current`, `details`, `auto` for OAuth profiles, unless `--offline` |
| `generativelanguage.googleapis.com` | Official Gemini models endpoint and connectivity probe | `list --check` for API key profiles; `doctor` unless `--offline` |

Browser OAuth callback servers bind strictly to `127.0.0.1` on an OS-assigned ephemeral port, enforce cryptographically random state parameters and PKCE (S256) challenges, serve generic error responses, apply no-store and no-referrer security headers, and close immediately upon completion or timeout.

Because the quota contracts are undocumented, they may change or be withdrawn without notice. Failures degrade to cached data and a warning; they never produce a fabricated reading.

## Credential Handling During Quota Refresh

- No access token or refresh token appears in a quota result, a log line, an exception message, a `--json` envelope, or any persisted diagnostic. Rotated tokens travel in a dedicated carrier whose serialization is `[redacted]`.
- Refreshing an expired token requires user-supplied OAuth client configuration (`AGY_OAUTH_CLIENT_ID`, optionally `AGY_OAUTH_CLIENT_SECRET`). Without it, the profile is reported as `expired` and recovery is a fresh Antigravity sign-in followed by `agy-auth sync`.
- Quota refresh never writes Antigravity's token file or Apple Keychain. Applying credentials to external state is the sole responsibility of `agy-auth switch`.
- A quota transport or schema failure never overwrites a credential status; only a successful reading, explicit insufficient-scope evidence, or an authentication rejection may.
