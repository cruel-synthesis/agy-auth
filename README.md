# agy-auth

`agy-auth` is a local credential profile manager and account switcher for Google Antigravity and Google AI development. It enables switching between multiple profiles for Antigravity OAuth sessions (Apple Keychain or Antigravity's token file), Gemini API keys (`GEMINI_API_KEY`), Service Account keys (`GOOGLE_APPLICATION_CREDENTIALS`), and Google Cloud Application Default Credentials (ADC).

> `agy-auth` is an independent project. It is **not affiliated with, endorsed by, or supported by Google**.

---

## Key Features

- **Multi-Account Switching**: Switch between multiple Google profiles for Antigravity and Gemini CLI workflows.
- **Authentication Methods**: Antigravity OAuth sessions, Gemini API keys, service-account JSON files, and authorized-user or service-account Google Cloud ADC.
- **Live Plan and Quota Reporting (experimental)**: `list`, `current`, and `details` show your subscription plan and remaining Gemini and Claude/GPT quota for 5-hour and weekly windows. See [the caveats below](#live-plan-and-quota-experimental).
- **Local-First Architecture**: Local metadata management under `~/.agy-auth/`. No telemetry, and nothing installed that runs on its own - `agy-auth auto --watch` keeps running only as long as you leave it running. Network access is limited to the quota, verification, token-refresh, and diagnostic requests documented below.
- **Machine Interface**: Non-interactive commands support `--json` with structured envelopes (`schemaVersion: 1`) and standard exit codes (0, 1, 2, 130).
- **Journaled Switching**: Validates inputs, snapshots affected state, and attempts compensating rollback for Antigravity settings, session stores, ADC, and service-account files. Rollback failures are reported.
- **Privacy & File Security**: Restricted POSIX file modes (`0700` directories, `0600` files), file-lock concurrency guards, symlink rejection, and redacted profile/status JSON. The `env` command deliberately emits shell values and can contain an API key.

---

## Installation

```bash
npm install -g @cruel-synthesis/agy-auth
```

Or run directly without global installation:

```bash
npx @cruel-synthesis/agy-auth --help
```

---

## Quick Start

### 1. Add the Account You Are Signed In To
Import the Google account currently signed in to Antigravity. Running it again
for the same account refreshes its stored session rather than duplicating it:

```bash
agy-auth add
```

### 2. Add Another Account
Sign in to a different Google account in the browser:

```bash
agy-auth login
```

Or add an API key through a masked prompt:

```bash
agy-auth add --api-key --email work@example.com --alias work
```

For automation, `--api-key <key>` remains available, but command-line values can be retained in shell history or exposed to local process inspection.

### 3. List and Switch Profiles
List your registered profiles and switch between them:

```bash
agy-auth list              # refreshes live quota for any profile whose reading has aged out
agy-auth list --offline    # cached data only, no network request
agy-auth list --check      # verify profiles and refresh quota for every OAuth profile
agy-auth switch work       # cached data only; never makes a network request
agy-auth switch 2
agy-auth auto              # switch to whichever account wastes the least quota
agy-auth auto --dry-run    # show the ranking and the choice without switching
agy-auth auto --watch      # keep running; switch whenever the account in use runs out
agy-auth -                 # Switch to previous profile
agy-auth current
```

The wide table shows:

```
     ACCOUNT                     PLAN   GEMINI 5H     GEMINI WK     CLAUDE 5H  CLAUDE WK  LAST
--------------------------------------------------------------------------------------------------
* 01 work (work@example.com)     Ultra  74% (18:40)   88% (26 Aug)  100%       96%        2m ago
  02 alt (alt@example.com)       Pro    stale         41% (27 Aug)  -          -          3h ago
```

Percentages are quota **remaining**. `-` means no cached value; `stale` means the cached window's reset time has passed and only a refresh can tell you the new figure. Narrow terminals drop columns in order: `LAST` first, then the weekly columns, then `CLAUDE 5H`, `GEMINI 5H`, and `PLAN`, down to an account-only list.

---

## Live Plan and Quota (experimental)

This feature is **experimental** because it depends on undocumented upstream contracts.

- It calls **undocumented Antigravity `v1internal` endpoints** on `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`. Google does not document or support them, and they may change or disappear at any time. When that happens `agy-auth` reports the quota as unavailable and keeps showing your last cached values; it never invents a number.
- The quota endpoints may return `429 RESOURCE_EXHAUSTED` while `loadCodeAssist` returns HTTP 200 without a recognized quota window. When any related contract returns a valid HTTP 200 but no quota window can be parsed, `agy-auth` reports `quota-unavailable` and preserves the cached quota instead of guessing. An explicit current plan or project returned by `loadCodeAssist` may still update that profile metadata.
- Each request sends your OAuth access token as a `Bearer` header plus, for `retrieveUserQuota`, the profile's GCP project ID. Quota payloads do not include local filenames, hostnames, or registry contents, and there is no telemetry or background polling.
- Only OAuth profiles are probed. API key, service account, and ADC profiles are never quota-probed.
- `agy-auth switch` never makes a network request.

### OAuth Onboarding and Token Refresh

- **Existing Antigravity Session (Out-of-the-box)**:
  `agy-auth add` imports an active Antigravity session from Apple Keychain on macOS or from Antigravity's token file on any platform. This flow verifies your identity via Google's `userinfo` endpoint using the access token and **requires no OAuth client ID**.
- **Browser Sign-In**:
  `agy-auth login` performs a PKCE loopback sign-in on any platform, using Antigravity's OAuth client and its scopes.
- **Which Client, and Why That One**:
  `agy-auth` carries the OAuth client ID and secret that Antigravity publishes in its own binary. Two facts make it the only workable choice. Google binds a refresh token to the client that issued it, so a session imported from Antigravity can be renewed by that client and by no other. And Google's individual tier now answers that client alone: asked under any other name, `loadCodeAssist` reports the tier as `UNSUPPORTED_CLIENT` and every quota call returns `403 SUBSCRIPTION_REQUIRED`, so an account signed in under a client of your own registers and then reports no plan and no quota for as long as you keep it. Installed-app clients cannot hold a secret ([RFC 8252 §8.5](https://www.rfc-editor.org/rfc/rfc8252#section-8.5)), which is why that pair ships readable inside Antigravity's own binary.

  To sign in under a client of your own instead, accepting that it will report neither plan nor quota:

```bash
export AGY_OAUTH_CLIENT_ID='your-client-id.apps.googleusercontent.com'
export AGY_OAUTH_CLIENT_SECRET='only-if-your-client-requires-one'   # optional
```

Token refresh (exchanging an existing refresh token for an access token), browser authorization (interactive sign-in via PKCE loopback callback), and Antigravity session import are distinct operations. Quota refresh and login never write Antigravity's token file or Apple Keychain; only `agy-auth switch` applies credentials to external state.

### 4. Apply Shell Environment Variables
When using API key or Service Account profiles, apply environment variables to your current POSIX shell session:

```bash
eval "$(agy-auth env)"
```

Or in PowerShell:

```powershell
Invoke-Expression (agy-auth env --shell powershell)
```

---

## Commands

| Command | Purpose |
|---|---|
| `agy-auth list` (or `ls`) | List profiles with plan and quota (`--active`, `--check`, `--offline`, `--json`); refreshes any OAuth profile whose reading is over ten minutes old |
| `agy-auth switch [selector]` | Switch active profile by number, alias, email, or interactive picker (cached data only, no network request) |
| `agy-auth -` | Switch to the previously active profile |
| `agy-auth auto` (or `best`) | Switch to the account whose quota is most at risk of going to waste (`--dry-run`, `--watch`, `--interval`, `--offline`, `--json`) |
| `agy-auth current` | Display details for the currently active profile (`--offline`, `--json`); refreshes live quota by default |
| `agy-auth details [selector]` | Display in-depth profile, model, project, plan, and quota configuration (`--offline`, `--json`) |
| `agy-auth login` | Add or refresh a Google OAuth account |
| `agy-auth add` | Add the account signed in to Antigravity, or another credential (`--api-key`, `--service-account`, `--adc`) |
| `agy-auth remove [selector...]` | Remove profiles (`--all`, `--yes`, `--json`) |
| `agy-auth alias <set\|clear>` | Assign or remove friendly nicknames for profiles |
| `agy-auth project <set\|clear>` | Configure Google Cloud Project ID and compute region |
| `agy-auth model <set\|clear>` | Configure preferred Gemini model setting |
| `agy-auth env` | Print shell environment exports and unsets (`--shell posix\|powershell`, `--clear`) |
| `agy-auth export [file]` | Export sanitized profile backup (`--include-secrets`, `--yes`, `--json`) |
| `agy-auth import <file>` | Import profiles with schema migration (`--overwrite`, `--json`) |
| `agy-auth clean` | Prune managed recovery snapshots (`~/.agy-auth/backups/`) |
| `agy-auth doctor` | Run environment and configuration diagnostics (`--offline`, `--json`) |

---

## Documentation

- [Quickstart Guide](./docs/quickstart.md)
- [JSON API Contract & Exit Codes](./docs/json-contract.md)
- [Platform Support](./docs/platform-support.md)
- [Privacy & Security Model](./PRIVACY.md)
- [Registry Schema and Migration](./docs/registry-schema.md)
- [Command Reference](./docs/commands/README.md)
- [Third-Party Notices](./THIRD_PARTY_NOTICES.md)

---

## Development

```bash
npm ci
npm run check
```

Keep changes scoped to one behavior. Add a regression test for a bug fix, and test
at the public boundary for new behavior. A public behavior change should update the
matching file under [docs/commands/](./docs/commands/README.md) and the changelog.

Exercise the CLI against temporary state, never your own:

```bash
root="$(mktemp -d)"
export AGY_AUTH_NO_NATIVE=1
export AGY_AUTH_HOME="${root}/.agy-auth"
export AGY_CLI_DIR="${root}/.gemini/antigravity-cli"
export AGY_SETTINGS_FILE="${AGY_CLI_DIR}/settings.json"
export AGY_TOKEN_FILE="${root}/token.json"
export AGY_GCLOUD_ADC_FILE="${root}/.config/gcloud/application_default_credentials.json"
npm run build && node ./bin/agy-auth.js --help
```

Those paths do not redirect the macOS Keychain; `AGY_AUTH_NO_NATIVE=1` is what keeps
a run off it. Verifying a credential store end to end means writing to one, so do
that on a disposable machine rather than your own. The native-access rules the suite
enforces live in `tests/setup-hermetic.ts` and `tests/native-isolation.test.ts`.

Never commit registry files, exports, OAuth payloads, API keys, service-account JSON,
ADC files, or logs containing them. Fixtures use unmistakably fake credentials.

Security reports belong in a private advisory, as described in [SECURITY.md](./SECURITY.md).

---

## License

[MIT](./LICENSE)
