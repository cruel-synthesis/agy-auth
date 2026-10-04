# remove

Remove one or more accounts from the local registry.

```shell
agy-auth remove [options] [selectors...]
agy-auth rm [options] [selectors...]
```

Arguments:

- `selectors`: Account selectors (number, alias, email, ID)

Options:

- `--all`: Remove all accounts
- `-y, --yes`: Skip confirmation prompt
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

Do not combine account selectors with `--all`; the command rejects that ambiguous destructive request. With `--json`, name the accounts or pass `--all`; JSON mode never opens the account picker.

Selectors are resolved before deletion to prevent indexing shifts. Removing the currently active account clears the active account pointer. Materialized service-account key files are cleaned up from `~/.agy-auth/accounts/`.
