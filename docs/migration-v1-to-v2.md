# Registry Migration (Schema v1 to Schema v2)

`agy-auth` v0.1.0 uses Registry Schema `2` to represent account profiles and settings.

---

## What Changed in Schema v2

1. **Explicit Auth Types**:
   All account profiles explicitly define `authType: 'oauth' | 'api-key' | 'service-account' | 'adc'`.
2. **Validated Status Model**:
   Allowed statuses are `valid | rate-limited | expired | invalid | needs-reauth | unverified | unknown`.
3. **Profile Configuration**:
   Added first-class fields for `alias`, `gcpProject`, `gcpLocation`, `model`, `reasoningEffort`, and optional `verification` timestamps.
4. **Validated Plan and Quota Cache**:
   Optional `plan`, `rateLimit`, and `quotaCheckedAt` fields hold the cached result of the last successful live quota fetch. `rateLimit` is restricted to the `gemini` and `claude` families and the 5-hour and weekly windows, with `usedPercent` bounded to `0..100`.
   The obsolete `primary`, `secondary`, `quotaSnapshot`, and polling-state fields are **not** carried over; they are dropped on migration.
5. **Standardized Backup & Export**:
   Export format `2` (`kind: 'agy-auth-export'`) replaces legacy ad-hoc dump arrays.

---

## Automatic Migration

When `agy-auth` opens `~/.agy-auth/registry.json` with `schemaVersion: 1` (or no `schemaVersion` field), it automatically upgrades that registry in place:

1. A pre-migration backup is created under `~/.agy-auth/backups/` with the `schema_1_migration_` prefix.
2. Legacy accounts are mapped to modern Schema v2 structures.
3. The migrated registry is atomically written to `~/.agy-auth/registry.json` with mode `0600` on POSIX systems.

A separate legacy `~/.agy-auth/accounts.json` file is detected by `agy-auth doctor` but is not imported automatically. Back it up, then copy it to `~/.agy-auth/registry.json` with owner-only permissions before starting `agy-auth`; the normal schema-v1 migration will then validate and upgrade it.

### Plan and quota during migration

- A legacy `plan` string and a legacy `quotaCheckedAt` timestamp are preserved when valid.
- Each legacy `rateLimit.gemini.*` and `rateLimit.claude.*` window is preserved **only if** it satisfies the strict schema. A malformed window (a non-numeric or out-of-range `usedPercent`, a nonsensical reset time) is dropped rather than repaired: inventing a value would present fiction as measurement.
- Legacy `rateLimit.primary`, `rateLimit.secondary`, and `quotaSnapshot` are discarded because they carry no model-family attribution.
- Missing cache data is entirely normal. Run `agy-auth list --check` to repopulate it from the live service.

### Already-current registries

A registry that already declares `schemaVersion: 2` loads unchanged, whether or not it carries the plan and quota fields. No migration runs and no backup is created because the new fields are optional and backward-compatible.

### Routine refreshes create no backups

Writing a refreshed plan or quota reading is a cache update, not a structural mutation, so it does **not** rotate the managed backup set. Otherwise every `agy-auth list` would consume a backup slot.

---

## Backup Rotation

Up to 10 managed mutation backups are retained in `~/.agy-auth/backups/`. Older managed backups are rotated automatically. You can delete all managed backups with:

```bash
agy-auth clean --all
```
