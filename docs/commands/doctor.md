# doctor

Check for problems.

```shell
agy-auth doctor [options]
```

Options:

- `--offline`: Skip external network reachability probe
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

Diagnostics checked:
- Storage directory permissions and integrity (`~/.agy-auth/`)
- Registry schema parsing and integrity (flags a registry still on an older schema)
- Antigravity token-file and native keyring session status
- Antigravity `settings.json` parsing
- Application Default Credentials (ADC) file validation
- Google API reachability probe (skipped when `--offline` is specified)

