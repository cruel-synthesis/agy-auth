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
| **Browser OAuth Sign-In with a user-supplied client** | Supported (`open`) | Supported (`xdg-open`) | Supported (`explorer.exe`) |
| **Antigravity token-file session import and switching** | Supported | Supported when Antigravity uses file-backed storage | Supported when Antigravity uses file-backed storage |
| **Native OS keyring import and switching** | Supported (Apple Keychain) | Not supported (Secret Service) | Not supported (Credential Manager) |
| **Atomic File Locking** | Supported (`fs.openSync('wx')`) | Supported (`fs.openSync('wx')`) | Supported (`fs.openSync('wx')`) |
| **Secure File Permissions (0700/0600)** | Enforced | Enforced | POSIX modes unavailable; protection depends on existing Windows ACLs |
| **Interactive Terminal TUI** | Supported | Supported | Supported (Windows Terminal / PowerShell) |

---

## Antigravity Session Stores

On macOS, Google Antigravity stores OAuth tokens inside the macOS Keychain under service `gemini` / account `antigravity`.

`agy-auth` integrates with Apple Keychain and Antigravity's `~/.gemini/antigravity-cli/antigravity-oauth-token` file. It reads the freshest valid session during `login` or `sync` and writes the token file during `switch`; on macOS it also updates Apple Keychain.

Antigravity can use native OS keyrings. Version 0.1 does not integrate with Linux Secret Service or Windows Credential Manager, so OAuth interoperability on those platforms requires Antigravity's file-backed token store. Custom browser OAuth remains available on every platform when you supply `AGY_OAUTH_CLIENT_ID`.
