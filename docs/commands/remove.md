# remove

Remove one or more profiles from agy-auth.

```shell
agy-auth remove [options] [selectors...]
agy-auth rm [options] [selectors...]
```

Arguments:

- `selectors...`: Profile selectors (row numbers, aliases, emails, or IDs) to remove

Options:

- `--all`: Remove all accounts (default: false)
- `-y, --yes`: Skip confirmation prompt (default: false)
- `-j, --json`: Output removal result as JSON

Selectors are resolved before deletion begins to prevent index shifting. If the currently active profile is removed, the active profile pointer is cleared. Materialized service-account key files in `~/.agy-auth/accounts/` are removed, while external Keychain items and gcloud ADC files are preserved.

Removal creates a managed recovery snapshot containing the pre-removal registry, including any stored credentials. Run `agy-auth clean --all` to delete all managed snapshots when recovery is no longer needed. JSON output reports this as `data.managedBackupCreated`.
