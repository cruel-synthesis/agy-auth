# list

```bash
agy-auth list [options]
agy-auth ls [options]
```

Options:

- `-a, --active`: Show only the currently active profile
- `-c, --check`: Verify credential health (validates Gemini API keys via the official models endpoint) **and** refresh live plan and quota for every selected OAuth profile
- `--offline`: Skip the live plan and quota refresh; render cached data only
- `-j, --json`: Output results as JSON

## Network behaviour

| Invocation | Refresh scope |
|---|---|
| `agy-auth list` | Live plan and quota for the **active OAuth profile** |
| `agy-auth list --active` | Same, restricted to the active profile |
| `agy-auth list --check` | Verify selected profiles (API keys use Google's official models endpoint) and refresh quota for **every selected OAuth profile**, at most 4 concurrent requests |
| `agy-auth list --offline` | No network request at all |

`--check --offline` is rejected as contradictory usage (exit code 2).

Non-OAuth profiles (API key, service account, ADC) are never quota-probed. Live plan and quota reporting is **experimental** and uses undocumented Antigravity endpoints; see [Privacy](../../PRIVACY.md) for hosts and payloads.

## Output

The wide layout is:

```text
ACCOUNT | PLAN | GEMINI 5H | GEMINI WK | CLAUDE 5H | CLAUDE WK | LAST
```

- Percentages are quota **remaining**.
- `-` means no cached value for that window.
- `stale` means the cached window's reset instant has passed; only a refresh can report the new figure.
- `expired`, `reauth`, `invalid`, and `limited` replace the reading when the profile itself is the problem.
- `LAST` is the last time the profile was made active. The time of the last successful quota fetch appears as `Quota check` in `current` and `details`.

Narrow terminals drop columns in order: `LAST`, then `CLAUDE WK`, `GEMINI WK`, `CLAUDE 5H`, `GEMINI 5H`, and `PLAN`. Extremely narrow terminals fall back to an account-only list. `agy-auth switch` uses the same renderer and widths.

If a refresh fails, `agy-auth` prints one warning and still renders the cached table. In `--json` mode the outcome appears in `data.quotaRefresh` instead; see [the JSON contract](../json-contract.md).
