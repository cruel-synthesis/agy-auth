# Command Reference

Overview of commands available in `agy-auth`.

---

## Core Commands

- [`list`](./list.md) (`ls`): List registered accounts (`-a`, `-c`, `--offline`, `-j`)
- [`switch`](./switch.md) (`sw`): Switch active account (`-j`)
- [`auto`](./auto.md) (`best`): Switch to the account whose quota is most at risk of going to waste (`-n`, `-w`, `--interval`, `--offline`, `-j`)
- [`current`](./current.md) (`whoami`): Show active account (`--offline`, `-j`)
- [`details`](./details.md) (`info`): Show detailed metadata for an account (`--offline`, `-j`)
- [`login`](./login.md): Sign in to a Google account in the browser
- [`add`](./add.md): Add the account signed in to Antigravity, or another credential (`--api-key`, `--service-account`, `--adc`, `-y`, `-j`)
- [`remove`](./remove.md) (`rm`): Remove one or more accounts (`--all`, `-y`, `-j`)

---

## Configuration and Maintenance

- [`alias`](./alias.md): Manage account aliases (`set`, `clear`)
- [`project`](./project.md): Manage GCP project settings (`set`, `clear`)
- [`model`](./model.md): Manage model preferences (`set`, `clear`)
- [`env`](./env.md): Print shell export commands for active account (`--shell`, `--clear`, `-j`)
- [`export`](./export.md): Export accounts to a backup file (`--include-secrets`, `-y`, `-j`)
- [`import`](./import.md): Import accounts from a backup file (`--overwrite`, `-j`)
- [`clean`](./clean.md): Remove old managed backup files (`--dry-run`, `--all`, `-j`)
- [`doctor`](./doctor.md): Inspect the local installation and environment (`--offline`, `-j`)
