# remove

Remove one or more credential profiles from the local registry.

```shell
agy-auth remove [options] [selectors...]
agy-auth rm [options] [selectors...]
```

Arguments:

- `selectors`: Profile selectors to remove (number, email, ID, alias)

Options:

- `--all`: Remove all accounts (default: false)
- `-y, --yes`: Skip confirmation prompt (default: false)
- `-j, --json`: Output removal result as JSON
- `-h, --help`: Show this help

Selectors are resolved before deletion to prevent indexing shifts. Removing the currently active profile clears the active profile pointer. Materialized service-account key files are cleaned up from `~/.agy-auth/accounts/`.
