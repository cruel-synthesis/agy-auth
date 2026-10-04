# export

Write a backup of saved accounts to a file.

```shell
agy-auth export [options] [output]
```

Arguments:

- `output`: Optional output destination file path or directory (defaults to a timestamped JSON file in the current working directory)

Options:

- `--include-secrets`: Include API keys and tokens in plaintext
- `-y, --yes`: Skip plaintext warning confirmation
- `-j, --json`: Output export summary metadata as JSON (destination, account count, and secrets flag)
- `-h, --help`: Show this help

Exports always write to a file on disk. Exported files are sanitized by default with credentials redacted. When `--include-secrets` is enabled, the exported file is written with owner-only permissions (`0600`).
