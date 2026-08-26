# clean

Remove old managed backup files from `~/.agy-auth/backups/`.

```shell
agy-auth clean [options]
```

Options:

- `--dry-run`: Show files that would be removed without deleting (default: false)
- `--all`: Remove all managed backups (retain 0 files) (default: false)
- `-j, --json`: Output removal results as JSON
- `-h, --help`: Show this help
