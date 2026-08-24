# env

Print shell environment commands (`export` or `$env:`) for the currently active credential profile.

```shell
agy-auth env [options]
```

Options:

- `--shell <posix|powershell>`: Shell syntax format (default: `posix` on Unix/macOS, `powershell` on Windows)
- `--clear`: Print `unset` / `Remove-Item` commands to reset Google environment variables
- `-j, --json`: Output environment variables as a JSON object

`env` is intentionally secret-bearing for API-key profiles. Its shell output can contain an API key, and JSON output returns the same values with `data.containsSecrets: true`. Do not log, publish, or paste this output into issue reports.

Usage Examples:

POSIX Shells (zsh / bash):
```shell
eval "$(agy-auth env)"
```

PowerShell:
```powershell
Invoke-Expression (agy-auth env --shell powershell)
```

Resetting environment variables:
```shell
eval "$(agy-auth env --clear)"
```
