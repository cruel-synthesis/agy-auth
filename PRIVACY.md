# Privacy and Security Model

`agy-auth` keeps account data local and includes no telemetry and installs no background service. Outbound requests are limited to the quota, verification, token-refresh, and diagnostic operations documented below.

`agy-auth` is an independent project. It is **not affiliated with, endorsed by, or supported by Google**.

---

## Core Privacy Principles

1. **No Telemetry or Analytics**:
   `agy-auth` does not include tracking scripts, usage telemetry, diagnostics uploaders, crash analytics, or phone-home beacons.

2. **Local Storage with Restricted Permissions**:
   All accounts, aliases, and credential references are stored on your local disk under `~/.agy-auth/` (configurable via `AGY_AUTH_HOME`).
   - On POSIX systems, `~/.agy-auth/` is created with mode `0700` (`rwx------`).
   - On POSIX systems, `~/.agy-auth/registry.json` and materialized credentials are created with mode `0600` (`rw-------`). Windows does not implement POSIX mode bits; protection there depends on the user's filesystem ACLs.

3. **Undocumented Endpoints Used Only for Live Plan and Quota (Experimental)**:
   Live plan and quota reporting calls undocumented Antigravity `v1internal` endpoints. Only this experimental feature uses those contracts, and reporting may stop working when they change.

   - Hosts contacted: `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`.
   - Contracts used: `v1internal:retrieveUserQuotaSummary`, `v1internal:loadCodeAssist`, `v1internal:retrieveUserQuota`.
   - What is sent: your OAuth access token as a `Bearer` header, an `agy-auth/<version>` user agent, and, for `retrieveUserQuota`, the GCP project ID associated with the account. These requests do not include local filenames, hostnames, or registry contents.
   - Token refresh and browser OAuth login contact `accounts.google.com`, `oauth2.googleapis.com`, and `www.googleapis.com`, using Antigravity's client unless `AGY_OAUTH_CLIENT_ID` names your own. Antigravity session import contacts `www.googleapis.com` to verify the account email.

   `agy-auth` embeds the OAuth client ID and secret published in Antigravity's own binary, because Google's individual tier answers that client and refuses others. An installed application cannot keep a secret (RFC 8252 section 8.5), so that pair identifies the application, never you. See [SECURITY.md](./SECURITY.md#network-boundary).

   Signing in requests these five scopes, the set Antigravity's client is
   registered for and the quota endpoints expect:

   - `https://www.googleapis.com/auth/cloud-platform`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/cclog`
   - `https://www.googleapis.com/auth/experimentsandconfigs`

   `cloud-platform` is broad. It reaches every Google Cloud resource the account
   can reach, not only the quota endpoints listed above. A stored refresh token
   carries that reach until you revoke it at
   [myaccount.google.com/permissions](https://myaccount.google.com/permissions),
   so keep it as you would keep your password.

4. **No Background Service**:
   `agy-auth` runs only when invoked from your terminal. It installs no background services, launch daemons, or cron jobs.
   `agy-auth auto --watch` polls for as long as you leave it running and stops when you close it or press Ctrl-C.

5. **Which Commands Use the Network**:

   | Command | Default behaviour |
   |---|---|
   | `agy-auth login` | Contacts Google userinfo when importing an Antigravity session. Interactive macOS onboarding may open Antigravity, which performs its own Google sign-in. Browser sign-in contacts Google's OAuth and token endpoints. |
   | `agy-auth switch` | **Never** makes a network request. Renders cached plan and quota only. |
   | `agy-auth list` | Refreshes live plan and quota for **every OAuth account whose cached reading is over ten minutes old**. |
   | `agy-auth list --check` | Verifies selected accounts (API keys use Google's official models endpoint) and refreshes live plan and quota for **every selected OAuth account** (at most 4 concurrent requests). |
   | `agy-auth current` | Refreshes live plan and quota for the active OAuth account. |
   | `agy-auth details <account>` | Refreshes live plan and quota for the selected OAuth account. |
   | `agy-auth auto` | Refreshes live plan and quota for every OAuth account whose cached reading is over ten minutes old, then may switch. |
   | `agy-auth auto --watch` | Each check refreshes the account in use; refreshes the others only when it runs out. |
   | `agy-auth doctor` | Optional reachability probe; suppressed with `--offline`. |
   | every other command | No network request. |

   - `--offline` on `list`, `current`, and `details` suppresses the refresh entirely and renders cached data. `--check --offline` is rejected as contradictory.
   - Non-OAuth accounts (API key, service account, ADC) are never quota-probed.
   - A refresh failure is non-fatal: `agy-auth` prints one warning and shows the cached values.

6. **Cached Quota Can Be Absent or Stale**:
   Cached plan and quota are a convenience, not a guarantee. An account that has never been refreshed shows `-`. A window whose reset instant has passed is shown as `stale`, never as its old percentage and never optimistically as `100%`: only a live refresh can say what the new window holds.

   The quota endpoints may return `429 RESOURCE_EXHAUSTED` while `loadCodeAssist` returns HTTP 200 without a recognized quota window. When any related contract returns a valid HTTP 200 but no quota window can be parsed, `agy-auth` reports `quota-unavailable`, preserves the cached quota and credential status, and displays `-` when no quota cache exists. An explicit current plan or project returned by `loadCodeAssist` may still update that account metadata.

7. **Recovering an Expired or Under-Scoped Account**:
   An imported Antigravity session is renewed with Antigravity's own OAuth client, so an access token that has merely expired is usually replaced without you doing anything. A refresh token that Google no longer honours, or a session missing the scopes the quota contracts want, cannot be repaired that way and needs a fresh sign-in.

   - A refresh token Google no longer honours leaves the account reported as `expired`. Sign in again through the Antigravity application, then run `agy-auth add`.
   - A token that the quota service rejects for missing scopes is reported as `needs-reauth`. Sign in again through Antigravity, then run `agy-auth add`.
   - If you have your own OAuth client, set `AGY_OAUTH_CLIENT_ID` (and `AGY_OAUTH_CLIENT_SECRET` if your client requires one) and `agy-auth` will refresh expired tokens itself or authenticate via `agy-auth login`, storing a rotated refresh token when Google issues one.
   - Quota refresh never writes Antigravity's token file or Apple Keychain. Only `agy-auth switch` applies stored credentials to external state.

8. **Safe Export and Sanitization**:
   - `agy-auth export` generates sanitized backups with all credentials redacted by default.
   - Plaintext credentials are included only when explicitly requested via `agy-auth export --include-secrets`.
   - Account and status JSON responses redact credentials. `agy-auth env` is the deliberate exception: its shell and JSON forms can emit the active API key so the caller can configure a shell. Do not log or share that output.

9. **Recovery Backups Retain Pre-Mutation State**:
   Switching, syncing, importing, and removing accounts may create owner-readable recovery snapshots under `~/.agy-auth/backups/`. Registry, ADC, and service-account snapshots can contain credentials; settings snapshots can contain other local Antigravity configuration. The 10 newest snapshots of each kind (switch, remove, import, and so on) are retained, so one busy operation cannot push out another's. Run `agy-auth clean --all` to delete them when recovery is no longer needed.

---

## Credential Handling

| Auth Type | Where It Originates | How It Is Stored |
|---|---|---|
| **OAuth (Antigravity CLI)** | Google Sign-in inside official Antigravity | Saved to `~/.agy-auth/registry.json`; `switch` writes Antigravity's token file and, on macOS, Apple Keychain |
| **API Key** | Google AI Studio (`GEMINI_API_KEY`) | Saved to `~/.agy-auth/registry.json` |
| **Service Account** | Google Cloud Console IAM service account JSON | Stored in the registry; switching to the account materializes `~/.agy-auth/accounts/<id>.json` (0600 on POSIX systems), which remains until that account is removed |
| **Application Default Credentials (ADC)** | `gcloud auth application-default login` | Path stored in the registry; switching a custom path copies its validated contents to the configured global ADC destination |

For manual API-key entry, use `agy-auth add --api-key` without a value to open a masked prompt. Supplying the key as `agy-auth add --api-key <key>` can leave it in shell history or expose it to local process inspection.

---

## Security Inquiries

If you discover a potential security issue, please review [SECURITY.md](./SECURITY.md) for reporting guidelines.
