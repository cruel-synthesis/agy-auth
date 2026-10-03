# doctor

Inspect the local installation and environment.

```shell
agy-auth doctor [options]
```

Options:

- `--offline`: Skip external network reachability probe (default: false)
- `--quota`: Ask the quota service directly and report its answers
- `-j, --json`: Output diagnostics as JSON
- `-h, --help`: Show this help

Diagnostics checked:
- Storage directory permissions and integrity (`~/.agy-auth/`)
- Registry schema parsing and integrity (flags a registry still on an older schema)
- Antigravity token-file and native keyring session status
- Antigravity `settings.json` parsing
- Application Default Credentials (ADC) file validation
- Google API reachability probe (skipped when `--offline` is specified)

## `--quota`

The quota endpoints are undocumented, so when `list` reports that the service
returned no recognized quota data, the only way to tell a changed contract from
an account with no quota is to look at the answer.

`--quota` calls each endpoint once for the active account (or, when that is not
a Google sign-in, the first saved one) and prints the HTTP
status and the response's shape: keys, array lengths, numbers, and short labels
such as window names and reset times. Strings longer than 120 characters, and
any string containing `@`, are replaced by their length.

This sends the account's access token to the quota service, exactly as a live
`list` does. It writes nothing.
