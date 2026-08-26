# login

Add or refresh a Google OAuth account, or onboard credentials interactively.

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

Interactive Onboarding:
When run interactively in a terminal, `agy-auth login` guides you through adding or refreshing credentials.

To add API key, Service Account, or ADC credentials non-interactively in scripts, use `agy-auth add [options]`.
