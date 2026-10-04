# clean

Delete old managed backup files from `~/.agy-auth/backups/`, keeping the newest
10 of each kind.

```shell
agy-auth clean [options]
```

Options:

- `--dry-run`: Show files that would be removed without deleting
- `--all`: Remove every managed backup, keeping none
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help
