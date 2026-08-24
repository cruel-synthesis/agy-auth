# import

Import profiles from an `agy-auth` JSON export backup file.

```shell
agy-auth import <file> [options]
```

Options:

- `--overwrite`: Overwrite matching accounts with imported profile metadata
- `-j, --json`: Output import summary as JSON envelope

The import operation runs under a process lock and creates a pre-import registry backup. A profile whose email and auth type match an existing profile is skipped unless `--overwrite` is specified. Account ID and identity collisions are rejected instead of being guessed or merged.
