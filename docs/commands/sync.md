# sync

Import active Antigravity macOS Keychain or local ADC credentials into the agy-auth registry.

```shell
agy-auth sync [options]
```

Options:

- `--oauth-email <email>`: Google account email for Keychain token
- `--adc-email <email>`: Email for local ADC credentials
- `-y, --yes`: Do not prompt; skip discoveries that still require an email (default: false)
- `-j, --json`: Output sync results as JSON

The command inspects local Keychain items and standard gcloud ADC files, importing discovered credentials into the registry. Discovered profiles automatically derive and verify identity via Google's userinfo endpoint when an access token is present, marking verified profiles as `valid`. If the profile already exists in the registry, existing refresh tokens and metadata are safely preserved. In non-interactive use where live userinfo lookup is unavailable, pass `--oauth-email` or `--adc-email`.
