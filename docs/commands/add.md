# add

Add an account.

```shell
agy-auth add [options]
```

With no options, `add` imports the Google account currently signed in to
Antigravity. This is the usual way to add an account, and running it again for
the same account refreshes the stored session rather than creating a duplicate.

```shell
agy-auth add
```

Antigravity owns the sign-in itself. If no session is present, sign in to
Antigravity first. If Google does not return the account address with the
session, `add` asks for it, or you can pass `--email`.

Options:

- `--email <email>`: Account email address
- `--alias <alias>`: Account alias
- `-y, --yes`: Do not prompt
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

## Other credential types

These cover credentials Antigravity does not hold. Pass at most one.

- `--api-key [key]`: Gemini API key; omit the value in a TTY for masked entry
- `--service-account <path>`: Path to Service Account JSON key file
- `--adc [path]`: Use Application Default Credentials (optional custom path)
- `--project <id>`: GCP project ID
- `--location <location>`: Compute region/location
- `--model <model>`: Preferred model name

```shell
# Gemini API key, without placing the key in command arguments
agy-auth add --api-key --email developer@example.com --alias personal

# Service Account JSON key
agy-auth add --service-account /path/to/sa-key.json --alias sa-prod

# Application Default Credentials from gcloud
agy-auth add --adc --alias gcloud-dev
```

For non-interactive use, pass the value as `--api-key <key>`. Command arguments
may be retained in shell history or visible to other local processes.

Added accounts start as unverified and are not activated. Run
`agy-auth switch <account>` to use one.
