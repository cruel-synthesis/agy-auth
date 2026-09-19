# alias

Manage account aliases.

```shell
agy-auth alias set <account> <alias> [options]
agy-auth alias clear <account> [options]
```

Arguments:

- `account`: Account selector (number, email, ID, or alias)
- `alias`: Unique alias nickname

Options:

- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

Examples:

```shell
# Set alias for account #1
agy-auth alias set 1 work

# Clear alias
agy-auth alias clear work
```
