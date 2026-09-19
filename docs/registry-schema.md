# Registry Schema and Migration

`agy-auth` stores your profiles in `~/.agy-auth/registry.json` under Registry Schema `3`. Older registries are upgraded when they are opened; you never run a migration yourself.

---

## Where It Lives

```text
~/.agy-auth/
├── registry.json       # Registry state (schema 3)
├── registry.lock       # Atomic mutation mutex
├── accounts/           # Materialized service account keys (mode 0600 on POSIX)
└── backups/            # Pre-mutation recovery snapshots
```

`AGY_AUTH_HOME` overrides the `~/.agy-auth/` base directory.

---

## What Schema 3 Holds

1. **Explicit Auth Types**:
   Every account profile declares `authType: 'oauth' | 'api-key' | 'service-account' | 'adc'`.
2. **Validated Status Model**:
   Allowed statuses are `valid | rate-limited | expired | invalid | needs-reauth | unverified | unknown`.
3. **Credential Provenance** (new in schema 3):
   An OAuth profile records where its credentials came from in `credentialSource: 'antigravity' | 'custom-client' | 'unknown'`. This decides which OAuth client renews its token. Registries written earlier carry no such record and it cannot be reconstructed, so they are marked `unknown` rather than assumed.
4. **Profile Configuration**:
   First-class fields for `alias`, `gcpProject`, `gcpLocation`, `model`, `reasoningEffort`, and optional `verification` timestamps.
5. **Validated Plan and Quota Cache**:
   Optional `plan`, `rateLimit`, and `quotaCheckedAt` fields hold the cached result of the last successful live quota fetch. `rateLimit` is restricted to the `gemini` and `claude` families and the 5-hour and weekly windows, with `usedPercent` bounded to `0..100`.
   The obsolete `primary`, `secondary`, `quotaSnapshot`, and polling-state fields are **not** carried over; they are dropped on migration.
6. **Standardized Backup & Export**:
   Export format `3` (`kind: 'agy-auth-export'`). `agy-auth import` also accepts format `2` and the legacy format `1` (`kind: 'agy-auth-profile-export'`), upgrading both on read.

---

## Automatic Migration

When `agy-auth` opens a registry that declares an older `schemaVersion` (or no `schemaVersion` field at all), it upgrades that registry in place:

1. A pre-migration backup is created under `~/.agy-auth/backups/` with the `schema_1_migration_` prefix.
2. Legacy accounts are mapped to schema 3 structures.
3. The migrated registry is atomically written to `~/.agy-auth/registry.json` with mode `0600` on POSIX systems.

A registry declaring a schema newer than this build understands is refused rather than downgraded.

A separate legacy `~/.agy-auth/accounts.json` file is detected by `agy-auth doctor` but is not imported automatically. Back it up, then copy it to `~/.agy-auth/registry.json` with owner-only permissions before starting `agy-auth`; the migration will then validate and upgrade it.

### Plan and quota during migration

- A legacy `plan` string and a legacy `quotaCheckedAt` timestamp are preserved when valid.
- Each legacy `rateLimit.gemini.*` and `rateLimit.claude.*` window is preserved **only if** it satisfies the strict schema. A malformed window (a non-numeric or out-of-range `usedPercent`, a nonsensical reset time) is dropped rather than repaired: inventing a value would present fiction as measurement.
- Legacy `rateLimit.primary`, `rateLimit.secondary`, and `quotaSnapshot` are discarded because they carry no model-family attribution.
- Missing cache data is entirely normal. Run `agy-auth list --check` to repopulate it from the live service.

### Already-current registries

A registry that already declares `schemaVersion: 3` loads unchanged. No migration runs and no backup is created.

### Routine refreshes create no backups

Writing a refreshed plan or quota reading is a cache update, not a structural mutation, so it does **not** rotate the managed backup set. Otherwise every `agy-auth list` would consume a backup slot.

---

## Backup Rotation

Up to 10 managed mutation backups are retained in `~/.agy-auth/backups/`. Older managed backups are rotated automatically. You can delete all managed backups with:

```bash
agy-auth clean --all
```
