# login

Sign in to another Google account in a browser.

```shell
agy-auth login [options]
```

Options:

- `--alias <alias>`: Account alias
- `--project <id>`: GCP project ID
- `--location <location>`: Compute region/location
- `--model <model>`: Preferred model name
- `-h, --help`: Show this help

`login` starts a PKCE loopback sign-in with Antigravity's OAuth client and its
scopes, and records the account as such so its quota can be refreshed later.
Set `AGY_OAUTH_CLIENT_ID` (and `AGY_OAUTH_CLIENT_SECRET` if your client needs
one) to use a client of your own instead; Google's individual tier answers only
Antigravity's, so an account added that way reports no plan and no quota.

To add the account already signed in to Antigravity, run `agy-auth add`, which
also covers API key, Service Account, and ADC credentials.
