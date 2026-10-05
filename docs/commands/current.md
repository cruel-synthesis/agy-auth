# current

Show the account in use: auth method, status, plan, quota and reset times, and
last use. Project, model and verification details are shown by
[`details`](./details.md) or in `--json` output.

```shell
agy-auth current [options]
agy-auth whoami [options]
```

Options:

- `-r, --refresh`: Fetch live plan and quota from Google before showing
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help
