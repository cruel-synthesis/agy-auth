# Command Reference

Selectors can be a 1-based row number from `list`, an alias, an email, an exact account ID, or an account ID prefix of at least four characters. Email and alias selectors may be substrings. If a selector matches more than one profile, non-interactive commands return an ambiguous-selector error and ask for a more specific selector.

---

## Profile Commands

- [`list`](./list.md): List profile state with plan and quota, or run explicit health checks (`--check`)
- [`switch`](./switch.md): Select and activate a credential profile (cached data only, no network request)
- [`current`](./current.md): Show the currently active profile with plan and quota
- [`details`](./details.md): Show detailed profile, model, project, plan, and quota metadata
- [`login`](./login.md): Add or refresh a credential profile (OAuth, API key, service account, ADC)
- [`sync`](./sync.md): Inspect and import local macOS Keychain and ADC credentials
- [`add`](./add.md): Add a profile using command-line arguments
- [`remove`](./remove.md): Remove profiles from the local registry

---

## Configuration and Maintenance

- [`alias`](./alias.md): Set or clear an alias for a profile
- [`project`](./project.md): Set or clear a profile's Google Cloud project and region
- [`model`](./model.md): Set or clear a profile's preferred Gemini model
- [`env`](./env.md): Print shell environment export and unset statements
- [`export`](./export.md): Create a sanitized or secret-bearing backup
- [`import`](./import.md): Import a profile backup with conflict resolution
- [`clean`](./clean.md): Prune managed recovery snapshots
- [`doctor`](./doctor.md): Run environment and configuration diagnostics

---

## Network Behaviour Summary

Live plan and quota reporting is **experimental** and uses undocumented Antigravity endpoints; see [Privacy](../../PRIVACY.md) for hosts and payloads.

| Command | Network by default |
|---|---|
| `login` | Contacts Google userinfo to verify imported session email (or Google OAuth endpoints when using custom browser OAuth) |
| `switch` | Never |
| `list` | Refreshes the active OAuth profile |
| `list --check` | Verifies selected profiles and refreshes selected OAuth profiles |
| `current`, `details` | Refreshes the selected OAuth profile |
| `doctor` | Reachability probe unless `--offline` |
| everything else | Never |

`list`, `current`, and `details` accept `--offline` to suppress the refresh. `list --check --offline` is rejected as contradictory usage.
