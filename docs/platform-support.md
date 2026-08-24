# Platform Support and OS Compatibility

`agy-auth` supports macOS, Linux, and Windows, with the platform differences below.

---

## Compatibility Matrix

| Feature | macOS (Darwin) | Linux | Windows |
|---|---|---|---|
| **API Key Authentication** | Supported | Supported | Supported |
| **Service Account JSON** | Supported | Supported | Supported |
| **Authorized-user or service-account ADC** | Supported | Supported | Supported |
| **External-account / Workload Identity Federation ADC** | Not supported in v0.1 | Not supported in v0.1 | Not supported in v0.1 |
| **Browser OAuth Sign-In** | Supported (`open`) | Supported (`xdg-open`) | Supported (`explorer.exe`) |
| **Antigravity CLI OAuth Switching (Keychain)** | Supported (macOS Keychain) | Not supported | Not supported |
| **Atomic File Locking** | Supported (`fs.openSync('wx')`) | Supported (`fs.openSync('wx')`) | Supported (`fs.openSync('wx')`) |
| **Secure File Permissions (0700/0600)** | Enforced | Enforced | POSIX modes unavailable; protection depends on existing Windows ACLs |
| **Interactive Terminal TUI** | Supported | Supported | Supported (Windows Terminal / PowerShell) |

---

## macOS Keychain Integration

On macOS, Google Antigravity stores OAuth tokens inside the macOS Keychain under service `gemini` / account `antigravity`.

`agy-auth` integrates with the macOS Keychain to read active tokens during `agy-auth sync` and write switched tokens during `agy-auth switch`.

On non-macOS platforms, API-key, service-account, and supported ADC profiles can be managed without macOS Keychain integration. Browser OAuth profiles can be registered on all platforms; switching an OAuth profile into Antigravity's Keychain is macOS-specific.
