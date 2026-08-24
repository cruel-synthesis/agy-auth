# details

Display account metadata, including authentication type, status, Google Cloud project, compute location, preferred model, subscription plan, remaining quota per window, creation time, and available activity, verification, and quota timestamps.

```shell
agy-auth details [selector] [options]
```

Options:

- `--offline`: Skip the live plan and quota refresh; render cached data only
- `-j, --json`: Output metadata as JSON envelope

Examples:

```shell
agy-auth details 1
agy-auth details work
agy-auth details --offline
agy-auth details --json
```

Without a selector, interactive terminals open a profile selection picker, while non-interactive environments default to the currently active profile.

By default this refreshes live plan and quota for the selected profile when it uses OAuth. Live plan and quota reporting is **experimental** and uses undocumented Antigravity endpoints; see [Privacy](../../PRIVACY.md). A refresh failure is non-fatal: one warning is printed and the cached values are shown.
