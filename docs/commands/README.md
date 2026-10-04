# Command Reference

Overview of commands available in `agy-auth`.

---

## Core Commands

- [`add`](./add.md): Add the account signed in to Antigravity, or another credential (`--api-key`, `--service-account`, `--adc`, `-y`, `-j`)
- [`login`](./login.md): Sign in to another Google account in a browser
- [`list`](./list.md) (`ls`): Show saved accounts, plan and quota (`-a`, `-c`, `--offline`, `-j`)
- [`switch`](./switch.md) (`sw`): Switch to a saved account (`-j`)
- [`current`](./current.md) (`whoami`): Show the account in use (`--offline`, `-j`)
- [`auto`](./auto.md) (`best`): Switch to the account whose quota is most at risk of going to waste (`-n`, `-w`, `--interval`, `--offline`, `-j`)
- [`details`](./details.md) (`info`): Show everything stored for one account (`--offline`, `-j`)
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
- [`doctor`](./doctor.md): Check for problems (`--offline`, `-j`)
