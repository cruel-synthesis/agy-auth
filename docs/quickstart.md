# Quick Start

## 1. Installation

Install `@cruel-synthesis/agy-auth` globally:

```bash
npm install -g @cruel-synthesis/agy-auth
```

Or run via npx:

```bash
npx @cruel-synthesis/agy-auth --help
```

---

## 2. Adding Profiles

### Option A: Sync Existing Local Credentials
Automatically detect existing Antigravity macOS Keychain tokens and Google Cloud ADC files:

```bash
agy-auth sync
```

### Option B: Google Account Login
Add or refresh an OAuth profile from your current macOS Antigravity session or a configured browser OAuth client:

```bash
# Choose current Antigravity session import or browser OAuth
agy-auth login

# Explicitly import active Antigravity session from macOS Keychain
agy-auth login --oauth-source keychain

# Or sign in with a custom Google Desktop OAuth Client ID
agy-auth login --oauth-source browser
```

### Option C: Add via CLI Arguments
Add a Gemini API key profile directly:

```bash
agy-auth add --email developer@example.com --api-key AIzaSy_MOCK_GEMINI_KEY_FOR_DOCS_00000 --alias personal
```

---

## 3. Managing and Switching Profiles

```bash
# List all registered profiles, refreshing live quota for the active OAuth profile
agy-auth list

# List without touching the network
agy-auth list --offline

# Verify profiles and refresh quota for every OAuth profile
agy-auth list --check

# Switch to a profile by alias, number, or email (never makes a network request)
agy-auth switch personal
agy-auth switch 2

# Toggle back to previous profile
agy-auth -

# Show active profile with plan and quota
agy-auth current
```

`list`, `switch`, and the interactive picker share one table:

```text
ACCOUNT | PLAN | GEMINI 5H | GEMINI WK | CLAUDE 5H | CLAUDE WK | LAST
```

Percentages are quota **remaining**; `-` means no cached value and `stale` means the cached window has already reset. Live plan and quota reporting is **experimental** because it uses undocumented Antigravity endpoints that can change without notice.

Refreshing an expired OAuth token needs your own OAuth client, since `agy-auth` ships none:

```bash
export AGY_OAUTH_CLIENT_ID='your-client-id.apps.googleusercontent.com'
```

Without it, an expired profile is reported as `expired`; sign in again through Antigravity and run `agy-auth sync`.

---

## 4. Applying Shell Environment Variables

When switching to an API Key or Service Account profile, export the required environment variables in your current POSIX shell session:

```bash
eval "$(agy-auth env)"
```

---

## 5. Running Diagnostics

Run a system diagnostic check:

```bash
agy-auth doctor
```
