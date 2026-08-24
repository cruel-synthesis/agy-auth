# alias

Manage profile aliases.

```shell
agy-auth alias set <account> <alias> [options]
agy-auth alias clear <account> [options]
```

Options:

- `-j, --json`: Output result as JSON

Aliases are case-insensitively unique nicknames containing alphanumeric characters, dashes, and underscores (1-32 characters).

Examples:

```shell
agy-auth alias set 1 work
agy-auth alias set user@example.com personal
agy-auth alias clear work
```
