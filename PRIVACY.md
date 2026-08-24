# Privacy and Security Model

`agy-auth` keeps profile data local and includes no telemetry or background service. Outbound requests are limited to the quota, verification, token-refresh, and diagnostic operations documented below.

`agy-auth` is an independent project. It is **not affiliated with, endorsed by, or supported by Google**.

---

## Core Privacy Principles

1. **No Telemetry or Analytics**:
   `agy-auth` does not include tracking scripts, usage telemetry, diagnostics uploaders, crash analytics, or phone-home beacons.

2. **Local Storage with Restricted Permissions**:
   All profiles, aliases, and credential references are stored on your local disk under `~/.agy-auth/` (configurable via `AGY_AUTH_HOME`).
   - On POSIX systems, `~/.agy-auth/` is created with mode `0700` (`rwx------`).
   - On POSIX systems, `~/.agy-auth/registry.json` and materialized credentials are created with mode `0600` (`rw-------`). Windows does not implement POSIX mode bits; protection there depends on the user's filesystem ACLs.

3. **Undocumented Endpoints Used Only for Live Plan and Quota (Experimental)**:
   Live plan and quota reporting calls undocumented Antigravity `v1internal` endpoints. Only this experimental feature uses those contracts, and reporting may stop working when they change.

   - Hosts contacted: `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`.
   - Contracts used: `v1internal:retrieveUserQuotaSummary`, `v1internal:loadCodeAssist`, `v1internal:retrieveUserQuota`.
   - What is sent: your OAuth access token as a `Bearer` header, an `agy-auth/<version>` user agent, and, for `retrieveUserQuota`, the GCP project ID associated with the profile. These requests do not include local filenames, hostnames, or registry contents.
   - Token refresh and browser OAuth login, when configured via `AGY_OAUTH_CLIENT_ID`, contact `accounts.google.com`, `oauth2.googleapis.com`, and `www.googleapis.com`. Session import contacts `www.googleapis.com` to verify account email.

   `agy-auth` does not embed an OAuth client secret and does not bundle an unverified third-party OAuth client ID.

4. **No Background Service**:
   `agy-auth` runs only when invoked from your terminal. It installs no background services, launch daemons, or cron jobs.

5. **Which Commands Use the Network**:

   | Command | Default behaviour |
   |---|---|
   | `agy-auth login` | Contacts Google userinfo to verify imported session email (or Google OAuth endpoints when using custom browser OAuth). |
   | `agy-auth switch` | **Never** makes a network request. Renders cached plan and quota only. |
   | `agy-auth list` | Refreshes live plan and quota for the **active OAuth profile**. |
   | `agy-auth list --check` | Verifies selected profiles (API keys use Google's official models endpoint) and refreshes live plan and quota for **every selected OAuth profile** (at most 4 concurrent requests). |
   | `agy-auth current` | Refreshes live plan and quota for the active OAuth profile. |
   | `agy-auth details <profile>` | Refreshes live plan and quota for the selected OAuth profile. |
   | `agy-auth doctor` | Optional reachability probe; suppressed with `--offline`. |
   | every other command | No network request. |

   - `--offline` on `list`, `current`, and `details` suppresses the refresh entirely and renders cached data. `--check --offline` is rejected as contradictory.
   - Non-OAuth profiles (API key, service account, ADC) are never quota-probed.
   - A refresh failure is non-fatal: `agy-auth` prints one warning and shows the cached values.

6. **Cached Quota Can Be Absent or Stale**:
   Cached plan and quota are a convenience, not a guarantee. A profile that has never been refreshed shows `-`. A window whose reset instant has passed is shown as `stale`, never as its old percentage and never optimistically as `100%`: only a live refresh can say what the new window holds.

   The quota endpoints may return `429 RESOURCE_EXHAUSTED` while `loadCodeAssist` returns HTTP 200 without a recognized quota window. When any related contract returns a valid HTTP 200 but no quota window can be parsed, `agy-auth` reports `quota-unavailable`, preserves the cached quota and credential status, and displays `-` when no quota cache exists. An explicit current plan or project returned by `loadCodeAssist` may still update that profile metadata.

7. **Recovering an Expired or Under-Scoped Profile**:
   `agy-auth` ships no OAuth client ID and no client secret, so it cannot mint a new access token on its own without user-supplied client configuration.

   - By default, an expired token is reported as `expired`. Sign in again through the Antigravity application, then run `agy-auth sync`.
   - A token that the quota service rejects for missing scopes is reported as `needs-reauth`, recovered the same way or by re-running `agy-auth login --method oauth`.
   - If you have your own OAuth client, set `AGY_OAUTH_CLIENT_ID` (and `AGY_OAUTH_CLIENT_SECRET` if your client requires one) and `agy-auth` will refresh expired tokens itself or authenticate via `agy-auth login --method oauth --oauth-source browser`, storing a rotated refresh token when Google issues one.
   - Quota refresh never writes the macOS Keychain. Only `agy-auth switch` applies stored credentials to external state.

8. **Safe Export and Sanitization**:
   - `agy-auth export` generates sanitized backups with all credentials redacted by default.
   - Plaintext credentials are included only when explicitly requested via `agy-auth export --include-secrets`.
   - Profile and status JSON responses redact credentials. `agy-auth env` is the deliberate exception: its shell and JSON forms can emit the active API key so the caller can configure a shell. Do not log or share that output.

9. **Recovery Backups Retain Pre-Mutation State**:
   Switching, syncing, importing, and removing profiles may create owner-readable recovery snapshots under `~/.agy-auth/backups/`. Registry, ADC, and service-account snapshots can contain credentials; settings snapshots can contain other local Antigravity configuration. Up to 10 managed snapshots are retained across these operations. Run `agy-auth clean --all` to delete them when recovery is no longer needed.

---

## Credential Handling

| Auth Type | Where It Originates | How It Is Stored |
|---|---|---|
| **OAuth (Antigravity CLI)** | Google Sign-in inside official Antigravity | Saved to `~/.agy-auth/registry.json` and synced to macOS Keychain |
| **API Key** | Google AI Studio (`GEMINI_API_KEY`) | Saved to `~/.agy-auth/registry.json` |
| **Service Account** | Google Cloud Console IAM service account JSON | Stored in the registry; switching to the profile materializes `~/.agy-auth/accounts/<id>.json` (0600 on POSIX systems), which remains until that profile is removed |
| **Application Default Credentials (ADC)** | `gcloud auth application-default login` | Path stored in the registry; switching a custom path copies its validated contents to the configured global ADC destination |

For manual API-key entry, prefer the masked `agy-auth login` prompt. Supplying a key through `agy-auth add --api-key` can leave it in shell history or expose it to local process inspection.

---

## Security Inquiries

If you discover a potential security issue, please review [SECURITY.md](./SECURITY.md) for reporting guidelines.
