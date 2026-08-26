# Command Reference

Overview of commands available in `agy-auth`.

---

## Core Commands

- [`list`](./list.md) (`ls`): List registered credential profiles (`-a`, `-c`, `--offline`, `-j`)
- [`switch`](./switch.md) (`sw`): Switch active credential profile (`-j`)
- [`current`](./current.md) (`whoami`): Show active credential profile (`--offline`, `-j`)
- [`details`](./details.md) (`info`): Show detailed metadata for a profile (`--offline`, `-j`)
- [`login`](./login.md): Add or refresh a Google OAuth account
- [`sync`](./sync.md): Import active Antigravity session or local ADC credentials (`--oauth-email`, `--adc-email`, `-y`, `-j`)
- [`add`](./add.md): Add a credential profile non-interactively (`--api-key`, `--service-account`, `--adc`, etc.)
- [`remove`](./remove.md) (`rm`): Remove one or more profiles (`--all`, `-y`, `-j`)

---

## Configuration and Maintenance

- [`alias`](./alias.md): Manage profile aliases (`set`, `clear`)
- [`project`](./project.md): Manage GCP project settings (`set`, `clear`)
- [`model`](./model.md): Manage model preferences (`set`, `clear`)
- [`env`](./env.md): Print shell export commands for active profile (`--shell`, `--clear`, `-j`)
- [`export`](./export.md): Export profiles to a backup file (`--include-secrets`, `-y`, `-j`)
- [`import`](./import.md): Import profiles from a backup file (`--overwrite`, `-j`)
- [`clean`](./clean.md): Remove old managed backup files (`--dry-run`, `--all`, `-j`)
- [`doctor`](./doctor.md): Inspect the local installation and environment (`--offline`, `-j`)
