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
- **Google browser sign-in**: starts the PKCE browser flow using `AGY_OAUTH_CLIENT_ID` and the optional `AGY_OAUTH_CLIENT_SECRET`.

To add API key, Service Account, or ADC credentials non-interactively in scripts, use `agy-auth add [options]`.
