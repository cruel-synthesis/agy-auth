# doctor

Inspect the local installation and environment.

```shell
agy-auth doctor [options]
```

Options:

- `--offline`: Skip external network reachability probe (default: false)
- `-j, --json`: Output diagnostics as JSON
- `-h, --help`: Show this help

Diagnostics checked:
- Storage directory permissions and integrity (`~/.agy-auth/`)
- Registry Schema v2 parsing and integrity (flags pending migration for legacy formats)
- macOS Keychain integration status
- Antigravity `settings.json` parsing
- Application Default Credentials (ADC) file validation
- Google API reachability probe (skipped when `--offline` is specified)
