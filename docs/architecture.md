# Architecture and Safety Boundaries

## Core Modules

- `src/core/storage.ts`: Owns atomic file writes, backup rotation (`MAX_BACKUP_RETENTION = 10`), and PID-guarded cross-process locking (`withLockSync`, `withLock`).
- `src/core/registry.ts`: Schema v2 registry validation, unique email/auth constraints, alias uniqueness, optimistic locking (`expectedUpdatedAt`), and atomic mutations.
- `src/core/switcher.ts`: Transactional profile switcher with preflight checks and dynamic journal rollbacks across Antigravity session stores, `settings.json`, service account JSON, and ADC credentials.
- `src/core/credential-files.ts`: File size guards (1 MiB max credential file, 5 MiB max import), symlink traversal prevention, and regular file validation.
- `src/core/verifier.ts`: Pure credential verifier (0 network calls for OAuth/SA/ADC, official models endpoint check for API keys, capped at 4 concurrent requests).
- `src/core/quota.ts`: Live plan and quota client for the undocumented Antigravity `v1internal` contracts (**experimental**). Injectable `fetch`, clock, per-request timeout and total per-account deadline; endpoint fallback; strict payload validation; bounded concurrency of 4.
- `src/core/quota-apply.ts`: The only path that writes quota-derived state, under the registry's locked transaction with optimistic concurrency on `updatedAt`.
- `src/core/antigravity-store.ts`: Composite Antigravity session reader and writer for Apple Keychain and the token file, with deterministic freshness selection and partial-store warnings.
- `src/core/keychain-import.ts`: Shared Antigravity session importer, userinfo-based email derivation/verification, and atomic profile merger.
- `src/core/oauth.ts`: Browser OAuth 2.0 PKCE flow with loopback callback server on `127.0.0.1`, state validation, verified userinfo lookup, security headers, and single-settlement server cleanup.
- `src/core/oauth-config.ts`: Environment-only OAuth client configuration. The package ships no client ID and no client secret.
- `src/core/keychain.ts`: Local macOS Keychain item inspection and replacement (0 network calls).
- `src/core/discovery.ts`: Local Antigravity settings metadata and Application Default Credentials discovery.
- `src/commands/refresh.ts`: Shared best-effort refresh helper used by `list`, `current`, and `details`; selects OAuth profiles, produces the JSON `quotaRefresh` summary and the single human-mode warning.
- `src/ui/table.ts`: Clean terminal output folding, responsive layout, Unicode/CJK-safe column widths, and the shared seven-column plan and quota renderer used by both `list` and the interactive picker.
- `src/ui/format.ts`: Single implementation of plan labels, quota cells, and the reset countdown, shared by the table, `current`, and `details`.
- `src/ui/tui.ts`: Clean interactive selector TUI with cursor restoration and signal cleanup.

---

## Directory Structure

```text
~/.agy-auth/
├── registry.json       # Registry Schema v2 state
├── registry.lock       # Atomic mutation mutex
├── accounts/           # Materialized service account keys (mode 0600 on POSIX)
└── backups/            # Pre-mutation recovery snapshots
```

`AGY_AUTH_HOME` overrides the default `~/.agy-auth/` base directory for testing and isolated environments.

---

## Transactional Switching Pipeline

Profile switching is serialized under process locks and executes through a journaled state machine:

1. **Preflight Validation**: Validates credential existence, schema, size, and file safety.
2. **Settings Preservation**: Backs up existing Antigravity settings and ADC files.
3. **Journaled Execution**: Applies file and session-store changes while recording compensating actions.
4. **Optimistic Registry Commit**: Updates active account pointer only if the registry was not concurrently modified.
5. **Compensating Rollback**: Automatically undoes changes in reverse order if any intermediate step fails.

---

## Live Plan and Quota Pipeline (experimental)

Quota reporting talks to undocumented Antigravity `v1internal` endpoints. They may change without notice, so every stage is written to fail closed onto cached data.

1. **Eligibility**: Only OAuth profiles with a stored access token are probed. Everything else returns `not-applicable` with no request.
2. **Token freshness**: A token whose recorded expiry is within 5 minutes is refreshed *only* when `AGY_OAUTH_CLIENT_ID` is present in the environment. Otherwise the profile is reported `expired` and no request is made.
3. **Contract A** (`retrieveUserQuotaSummary`): tried first, with the mirror host as fallback. If it yields at least one recognized family/window, the result is accepted.
4. **Plan and project discovery** (`loadCodeAssist`): supplies the plan name and, when the profile has no project configured, a project ID. It never overrides a project the user set.
5. **Contract B** (`retrieveUserQuota`): tried only when a real project ID is available. No default project is ever invented.
6. **Commit**: `quota-apply.ts` re-reads the account under the registry lock and writes only quota-derived fields, and only if `updatedAt` is unchanged since the request began.

### Bounds

| Bound | Value |
|---|---|
| Total deadline per account | 15 s across every request it makes |
| Per-request timeout | 8 s, clamped by the remaining total deadline |
| Concurrent accounts | 4 |
| Batch semantics | `Promise.allSettled`; one account's failure never aborts the batch |

### Accepted payload shapes

Only explicit `gemini` and `claude`/`gpt`/`3p` families and explicit 5-hour and weekly windows are accepted. A bucket is dropped when its fraction is outside `0..1` or non-finite, its window label is unknown or self-contradictory, or its family is ambiguous. When several buckets map to one family/window pair, the most constrained remaining quota wins, with the earliest valid reset time as tie-breaker. A syntactically valid response with no recognized window is `quota-unavailable`, not success.

### Error policy

| Condition | Status effect | Cache effect |
|---|---|---|
| Recognized quota returned | `valid` | replaced, `quotaCheckedAt` stamped |
| HTTP 401 after any permitted refresh | `expired` | preserved |
| Explicit insufficient-scope evidence | `needs-reauth` | preserved |
| Generic 403, 429, 5xx, timeout, malformed body, network failure | unchanged | quota snapshot preserved |
| Expired token with no `AGY_OAUTH_CLIENT_ID` | `expired` | preserved |

The reported reason distinguishes a valid but unusable payload from other failures: if any contract returned a syntactically valid HTTP 200 object, the failure is `quota-unavailable`. If no request did so and there was no decisive authentication or scope result, it is `network-error`; this category includes timeouts, malformed bodies, and non-decisive HTTP errors such as 429 or 5xx.

A successfully parsed current plan or discovered project may be applied even when no quota window is usable. This partial update does not change credential status, `rateLimit`, or `quotaCheckedAt`.

During `list --check` the verifier result lands first and a *decisive* quota outcome (success, scope failure, authentication failure) overrides it. A quota transport or schema failure carries no status and can never overwrite a meaningful verifier verdict.

### Reachable service without usable quota data

These contracts are undocumented. The quota endpoints can return `429 RESOURCE_EXHAUSTED` while `loadCodeAssist` returns an HTTP 200 response containing only `allowedTiers` or `ineligibleTiers`, without a current tier or recognized quota window.

Because a related contract returned a valid HTTP 200 object in that combination, `agy-auth` reports `quota-unavailable`, preserves credential status and cached quota, and renders `-` when no quota cache exists. It does not infer a current plan from `allowedTiers`, because that field describes tiers a client may use rather than the tier assigned to the account.

### Staleness

`quotaCheckedAt` records the last successful live fetch. A cached window whose `resetsAt` has passed renders as `stale`, not as `100%` or its old percentage, because the cache says nothing about usage after the reset.
