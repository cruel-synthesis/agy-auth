# Machine-Readable JSON Contract

Non-interactive commands in `agy-auth` support the `--json` flag, providing structured, deterministic machine output for scripting, CI/CD pipelines, and editor extensions.

Supported commands: `list`, `current`, `details`, `switch`, `add`, `remove`, `alias`, `project`, `model`, `env`, `export`, `import`, `add`, `clean`, `doctor`. (Interactive terminal onboarding via `login` is terminal-only.)

---

## Output Envelope

### Success Envelope

All successful JSON commands output a top-level JSON object with `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "command": "<command-name>",
  "ok": true,
  "data": { ... }
}
```

### Error Envelope

Command errors in JSON mode output a top-level JSON error object to `stdout` with silent `stderr` and exit with a non-zero exit code:

```json
{
  "schemaVersion": 1,
  "command": "<command-name>",
  "ok": false,
  "error": {
    "code": "account_not_found",
    "message": "Account 'work@example.com' not found.",
    "details": { ... }
  }
}
```

An unreadable or corrupted Antigravity Keychain/token-file pair uses the `session_store_error` code.

---

## Standard Exit Codes

`agy-auth` adheres strictly to standard UNIX CLI exit codes:

| Exit Code | Classification | Description |
|---|---|---|
| `0` | **Success** | The command completed successfully or was dismissed cleanly (e.g. Esc/q in interactive selection). |
| `1` | **Operational Error** | An operational failure occurred (e.g. `AccountNotFoundError`, `AmbiguousSelectorError`, file I/O error, failed verification). |
| `2` | **Usage / Syntax Error** | Invalid flags, missing required options, non-interactive mode without selector, or CLI argument validation errors (`UsageError`, Commander error). |
| `130` | **Interrupted** | The process was terminated via `SIGINT` (Ctrl+C). |

---

## Plan and Quota Fields

The account object returned by `list`, `current`, `details`, and `switch` carries three **optional** quota fields. They are omitted when no cached value exists, so consumers must treat each field as possibly absent. The envelope stays at `schemaVersion: 1` and the registry at schema version `2`; these additions are backward-compatible.

```json
{
  "id": "acc_1f2e3d4c",
  "email": "work@example.com",
  "authType": "oauth",
  "status": "valid",
  "plan": "Google AI Ultra",
  "quotaCheckedAt": 1787351130852,
  "rateLimit": {
    "gemini": {
      "rate5h": { "usedPercent": 26, "windowMinutes": 300, "resetsAt": 1787368800 },
      "rateWeekly": { "usedPercent": 12, "windowMinutes": 10080, "resetsAt": 1787788800 }
    },
    "claude": {
      "rate5h": { "usedPercent": 0, "windowMinutes": 300 }
    }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `plan` | `string` (≤128 chars), optional | Subscription plan name as reported by `loadCodeAssist`. |
| `quotaCheckedAt` | integer epoch **milliseconds**, optional | Time of the last **successful** live quota fetch. Absent means never fetched. |
| `rateLimit.<family>.<window>.usedPercent` | number `0..100` | Percentage **used**. The CLI renders remaining (`100 - usedPercent`). |
| `rateLimit.<family>.<window>.windowMinutes` | positive integer | `300` for the 5-hour window, `10080` for the weekly window. |
| `rateLimit.<family>.<window>.resetsAt` | integer epoch **seconds**, optional | When the window resets. A value in the past means the cached reading is stale; the CLI renders `stale`. |

`<family>` is `gemini` or `claude` (the `claude` family covers Claude and GPT third-party models). `<window>` is `rate5h` or `rateWeekly`. Any family or window absent from the payload simply has no cached value.

`status` may additionally be `needs-reauth`, meaning the token was explicitly rejected for insufficient scopes.

---

## Quota Refresh Summary

`list`, `current`, and `details` include a `data.quotaRefresh` object describing whether a live refresh was attempted and how it went. It is secret-free by construction.

```json
{
  "quotaRefresh": {
    "attempted": true,
    "offline": false,
    "accounts": [
      { "accountId": "acc_1f2e3d4c", "ok": true },
      { "accountId": "acc_9a8b7c6d", "ok": false, "reason": "token-expired" }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `attempted` | `true` when at least one profile was contacted. |
| `offline` | `true` when `--offline` suppressed the refresh. |
| `accounts[].reason` | Present only on failure. One of `not-applicable`, `token-expired`, `scope-insufficient`, `auth-failed`, `quota-unavailable`, `network-error`. |

A failed refresh does **not** fail the command: `ok` stays `true`, the cached values are returned, and `stderr` stays silent in JSON mode.

---

## Redaction and Sanitization

Profile, list, switch, details, and diagnostic JSON strips private keys, API keys, and OAuth tokens. Two commands are intentionally different:

- `agy-auth env --json` returns environment values and marks the response with `data.containsSecrets: true`; an API-key profile exposes its API key there by design.
- `agy-auth export --include-secrets` writes credentials to the requested file; its JSON envelope returns destination metadata, not the credentials themselves.

No access token or refresh token ever appears in a JSON envelope, including on the quota refresh paths. A rotated OAuth token is persisted to the registry but is never emitted: its in-memory carrier serializes to `[redacted]`.
