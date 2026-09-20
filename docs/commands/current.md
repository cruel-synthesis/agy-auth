# current

Show the active account: auth method, status, plan, quota and reset times, and
last use. Project, model and verification details are shown by
[`details`](./details.md) or in `--json` output.

```shell
agy-auth current [options]
agy-auth whoami [options]
```

Options:

- `--offline`: Skip the live plan and quota refresh; show cached data only (default: false)
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help
