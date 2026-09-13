# login

Sign in to a Google account in the browser.

```shell
agy-auth login [options]
```

Options:

- `--alias <alias>`: Profile alias
- `--project <id>`: GCP project ID
- `--location <location>`: Compute region/location
- `--model <model>`: Preferred model name
- `-h, --help`: Show this help

`login` starts a PKCE loopback sign-in with your own Google Desktop OAuth client,
so it requires `AGY_OAUTH_CLIENT_ID` (and `AGY_OAUTH_CLIENT_SECRET` if your client
needs one). `agy-auth` ships no OAuth client of its own.

To add the account already signed in to Antigravity, run `agy-auth add`; that flow
needs no OAuth client. `agy-auth add` also covers API key, Service Account, and
ADC credentials.
