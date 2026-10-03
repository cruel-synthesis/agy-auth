# Registry Schema and Migration

`agy-auth` stores your accounts in `~/.agy-auth/registry.json` under Registry Schema `3`. A schema `2` registry is upgraded when it is opened; you never run a migration yourself. Any other schema version is refused rather than guessed at.

Three version numbers appear in this project and they are independent: the registry schema (`3`), the export document format (`3`, with format `2` still readable), and the `--json` response envelope (`schemaVersion: 1`, documented in [the JSON contract](./json-contract.md)).

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
   Every account declares `authType: 'oauth' | 'api-key' | 'service-account' | 'adc'`.
2. **Validated Status Model**:
   Allowed statuses are `valid | rate-limited | expired | invalid | needs-reauth | unverified | unknown`.
3. **Credential Provenance** (new in schema 3):
   An OAuth account records where its credentials came from in `credentialSource: 'antigravity' | 'custom-client' | 'unknown'`. This decides which OAuth client renews its token. Registries written earlier carry no such record and it cannot be reconstructed, so they are marked `unknown` rather than assumed; one that holds an imported Antigravity session is renewed with Antigravity's client.
4. **Account Configuration**:
   First-class fields for `alias`, `gcpProject`, `gcpLocation`, `model`, `reasoningEffort`, and optional `verification` timestamps.
5. **Validated Plan and Quota Cache**:
   Optional `plan`, `rateLimit`, and `quotaCheckedAt` fields hold the cached result of the last successful live quota fetch. `rateLimit` is restricted to the `gemini` and `claude` families and the 5-hour and weekly windows, with `usedPercent` bounded to `0..100`.
6. **Standardized Backup & Export**:
   Export format `3` (`kind: 'agy-auth-export'`). `agy-auth import` also accepts format `2`, converting it as it reads. The file you import is never written back.

---

## Automatic Migration

When `agy-auth` opens a registry that declares `schemaVersion: 2`, it upgrades that registry in place:

1. The whole document is parsed strictly against the schema 2 shape: its accounts, its `activeAccountId` and `previousAccountId`, its `settings`, and no other key. If any part of it fails, the file is refused and left untouched: half a registry is worse than a clear error, and a value schema 2 could not have held is reported rather than replaced with a default.
2. OAuth accounts gain `credentialSource: 'unknown'`. Account pointers and settings carry over exactly as they were written.
3. The result is validated as a complete schema 3 registry, including that `activeAccountId` and `previousAccountId` still name accounts that exist.
4. Only then is a backup written under `~/.agy-auth/backups/` with the `schema_migration_` prefix. If the backup cannot be created, the migration aborts with the registry untouched.
5. The migrated registry is atomically written to `~/.agy-auth/registry.json` with mode `0600` on POSIX systems.

### Refused schema versions

Schema `1` was never written by `agy-auth`, and a schema newer than this build understands cannot be downgraded. Both are refused by name, as is a registry with a missing or non-numeric `schemaVersion`. In every case the file on disk is left exactly as it was found.

A separate legacy `~/.agy-auth/accounts.json` file is detected by `agy-auth doctor` but is not imported automatically. Back it up, then copy it to `~/.agy-auth/registry.json` with owner-only permissions before starting `agy-auth`; it is accepted only if it declares schema `2` or `3`.

### Already-current registries

A registry that already declares `schemaVersion: 3` loads unchanged. No migration runs and no backup is created.

### Routine refreshes create no backups

Writing a refreshed plan or quota reading is a cache update, not a structural mutation, so it does **not** rotate the managed backup set. Otherwise every `agy-auth list` would consume a backup slot.

---

## Backup Rotation

The 10 newest managed backups of each kind (switch, remove, import, and so on) are retained in `~/.agy-auth/backups/`, so one busy operation cannot push out another's. Older ones are rotated automatically, and `agy-auth clean` applies the same rule. You can delete all managed backups with:

```bash
agy-auth clean --all
```
