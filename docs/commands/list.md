# list

Show saved accounts, plan and quota.

```shell
agy-auth list [options]
agy-auth ls [options]
```

Options:

- `-a, --active`: Show only the active account
- `-r, --refresh`: Fetch live plan and quota from Google before showing
- `-c, --check`: Also verify each account can still sign in (implies `--refresh`)
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

A plain `list` makes no network request and shows the last reading saved for
each account. `--refresh` asks Google for every OAuth account whose reading is
older than ten minutes, so the whole table is current without switching to each
account in turn. Accounts that need a fresh sign-in are skipped until you sign
in again; `--check` asks about them anyway.

Live readings use undocumented Antigravity endpoints and Antigravity's own
client identity, which Google's Antigravity terms may treat as third-party
access. See [Responsible use](../../README.md#responsible-use).
