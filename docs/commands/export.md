# export

Export stored profiles to a backup file.

```shell
agy-auth export [options] [output]
```

Arguments:

- `output`: Optional destination file path or directory (defaults to a timestamped file in the current working directory)

Options:

- `--include-secrets`: Include API keys and tokens in plaintext (mode `0600` on POSIX systems; verify destination ACLs on Windows; default: false)
- `-y, --yes`: Skip plaintext warning confirmation prompt (default: false)
- `-j, --json`: Output destination metadata envelope as JSON

Exports always write to a file on disk. In JSON mode (`-j, --json`), the command completes file creation and outputs the destination metadata and account count envelope.
