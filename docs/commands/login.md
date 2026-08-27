# login

Add or refresh a Google OAuth account.

```shell
agy-auth login [options]
```

Options:

- `--oauth-source <source>`: Login source (`keychain`, `browser`)
- `--email <email>`: Email fallback for current Antigravity account
- `--alias <alias>`: Profile alias
- `--project <id>`: GCP project ID
- `--location <location>`: Compute region/location
- `--model <model>`: Preferred model name
- `-h, --help`: Show this help

Without `--oauth-source`, the interactive command offers the available OAuth sources:

- **Current Antigravity account** (macOS): imports the active Antigravity Keychain session. This option appears only when a session is available and does not require an OAuth client ID.
- **Sign in through Antigravity** (macOS): opens Antigravity for Google sign-in, waits for you to return, and imports the resulting Keychain session. This option does not require an OAuth client ID.
- **Custom browser sign-in**: starts the direct PKCE browser flow using `AGY_OAUTH_CLIENT_ID` and the optional `AGY_OAUTH_CLIENT_SECRET`. On macOS this option appears only when a client ID is configured.

To add API key, Service Account, or ADC credentials non-interactively in scripts, use `agy-auth add [options]`.
