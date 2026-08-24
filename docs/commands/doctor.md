# doctor

Inspect the local installation, storage directories, registry schema integrity, macOS Keychain state, settings file, and Google API reachability.

```shell
agy-auth doctor [options]
```

Options:

- `--offline`: Skip external network reachability probe (default: false)
- `-j, --json`: Output diagnostics results as JSON

The command performs read-only diagnostics. It does not modify credentials, rewrite files, or mutate registry configuration. Checks cover POSIX storage and registry modes, registry schema, credential shape, unique IDs, unique aliases and identities, and valid active/previous pointers.
