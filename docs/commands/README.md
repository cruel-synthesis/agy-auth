# Command Reference

Overview of commands available in `agy-auth`.

---

## Core Commands

- [`add`](./add.md): Add the account signed in to Antigravity, or another credential (`--api-key`, `--service-account`, `--adc`, `-y`, `-j`)
- [`login`](./login.md): Sign in to another Google account in a browser
- [`list`](./list.md) (`ls`): Show saved accounts, plan and quota (`-a`, `-c`, `--offline`, `-j`)
- [`switch`](./switch.md) (`sw`): Switch to a saved account (`-j`)
- [`current`](./current.md) (`whoami`): Show the account in use (`--offline`, `-j`)
- [`auto`](./auto.md) (`best`): Switch to the account whose quota is most at risk of going to waste (`-n`, `--offline`, `-j`)
- [`details`](./details.md) (`info`): Show everything stored for one account (`--offline`, `-j`)
- [`remove`](./remove.md) (`rm`): Remove saved accounts (`--all`, `-y`, `-j`)

---

## Configuration and Maintenance

- [`alias`](./alias.md): Set or clear an account alias (`set`, `clear`)
- [`project`](./project.md): Set or clear the GCP project (`set`, `clear`)
- [`model`](./model.md): Set or clear the preferred model (`set`, `clear`)
- [`env`](./env.md): Print shell export commands for the active account (`--shell`, `--clear`, `-j`)
- [`export`](./export.md): Write a backup of saved accounts (`--include-secrets`, `-y`, `-j`)
- [`import`](./import.md): Read a backup of saved accounts (`--overwrite`, `-j`)
- [`clean`](./clean.md): Delete old managed backup files (`--dry-run`, `--all`, `-j`)
- [`doctor`](./doctor.md): Check for problems (`--offline`, `-j`)
