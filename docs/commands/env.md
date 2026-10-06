# env

Print shell export commands for the active account.

> Not yet verified with agy, so hidden from `--help`. According to agy's documentation it reads an API key only when
> `settings.json` sets `modelProvider` to `"gemini"`, and ADC only with `AGY_ADC_AUTH=true`. agy-auth sets neither yet.

```shell
agy-auth env [options]
```

Options:

- `--shell <posix|powershell>`: Shell output format (default: `posix` on Unix/macOS, `powershell` on Windows)
- `--clear`: Print unset statements to reset environment
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
