# clean

Remove old managed backup files from `~/.agy-auth/backups/`.

```shell
agy-auth clean [options]
```

Options:

- `--dry-run`: Show files that would be removed without deleting (default: false)
- `--all`: Remove all managed backups (retain 0 files; default: false)
- `-j, --json`: Output clean summary as JSON

By default, `agy-auth clean` retains the 10 newest managed recovery snapshots and removes older managed snapshots. These can include registry, ADC, service-account, and Antigravity settings snapshots. The command does not delete unrelated files placed in the backup directory.
