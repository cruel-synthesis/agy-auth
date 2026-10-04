# env

Print shell export commands for active account.

```shell
agy-auth env [options]
```

Options:

- `--shell <posix|powershell>`: Shell output format (default: `posix` on Unix/macOS, `powershell` on Windows)
- `--clear`: Print unset statements to reset environment (default: false)
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

Usage Examples:

```shell
# Apply variables in POSIX shell (zsh / bash)
eval "$(agy-auth env)"

# Apply variables in PowerShell
agy-auth env --shell powershell | Out-String | Invoke-Expression

# Reset environment variables
eval "$(agy-auth env --clear)"
```
