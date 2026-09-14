# list

List registered credential profiles.

```shell
agy-auth list [options]
agy-auth ls [options]
```

Options:

- `-a, --active`: Show only currently active profile
- `-c, --check`: Verify listed profiles and refresh live quota for listed OAuth profiles
- `--offline`: Skip the live plan and quota refresh; show cached data only (default: false)
- `-j, --json`: Output results as JSON
- `-h, --help`: Show this help

Quota readings are cached for ten minutes. An ordinary `list` refreshes every OAuth
profile whose reading is older than that, so the whole table stays current without
switching to each profile in turn. Profiles that need a fresh sign-in are skipped
until you sign in again; `--check` asks about them anyway.
