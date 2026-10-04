# alias

Set or clear an account alias.

```shell
agy-auth alias set <account> <alias> [options]
agy-auth alias clear <account> [options]
```

Arguments:

- `account`: Account selector (number, alias, email, ID)
- `alias`: Alias name: up to 32 letters, digits, `_` or `-`, starting with a letter or digit, and unique among saved accounts

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
