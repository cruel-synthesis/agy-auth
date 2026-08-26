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
