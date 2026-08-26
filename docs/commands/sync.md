# sync

Import active Antigravity macOS Keychain tokens or local Google Cloud ADC credentials.

```shell
agy-auth sync [options]
```

Options:

- `--oauth-email <email>`: Google account email for Keychain token
- `--adc-email <email>`: Email for local ADC credentials
- `-y, --yes`: Do not prompt; skip discoveries that require an email (default: false)
- `-j, --json`: Output discovered and imported profiles as JSON
- `-h, --help`: Show this help

Discovered profiles are imported into the local registry. Discovered profiles start as unverified until explicitly verified or activated. `sync` does not automatically activate discovered profiles.
