# current

```bash
agy-auth current [--offline] [--json]
```

Shows details for the currently active credential profile, including authentication type, status, Google Cloud project, compute location, preferred model, subscription plan, remaining quota per window, and verification state. JSON output redacts sensitive credentials.

By default this refreshes live plan and quota for the active profile when it uses OAuth. Pass `--offline` to render cached data with no network request. Live plan and quota reporting is **experimental** and uses undocumented Antigravity endpoints; see [Privacy](../../PRIVACY.md).

A refresh failure is non-fatal: one warning is printed and the cached values are shown. `Quota check` reports how long ago the last successful live fetch happened, or `never`.
