<div align="center">

# agy-auth

**Switch Google accounts for Antigravity in one command.**

Keep every Google AI account you own signed in, see each one's plan and remaining quota side by side, and move Antigravity to the one you want without signing out.

[![npm](https://img.shields.io/npm/v/@cruel-synthesis/agy-auth?color=cb3837&logo=npm)](https://www.npmjs.com/package/@cruel-synthesis/agy-auth)
[![CI](https://github.com/cruel-synthesis/agy-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/cruel-synthesis/agy-auth/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@cruel-synthesis/agy-auth?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

<img src="https://raw.githubusercontent.com/cruel-synthesis/agy-auth/main/.github/assets/demo.gif" alt="agy-auth listing five accounts, switching to one from the interactive picker, and switching back with agy-auth -" width="860">

</div>

---

## Why

Antigravity signs in to one Google account at a time. If you have a work account, a personal one and a spare, moving between them means signing out, going through the browser again, and losing track of which account still has quota left.

`agy-auth` saves each account once and then:

- **switches in one command**, by alias, email or number, or from an arrow-key picker;
- **switches back** to the previous account with `agy-auth -`, like `cd -`;
- **shows every account together**: plan, 5-hour and weekly quota for Gemini and Claude, and when each resets;
- **makes no network request to switch.** A switch rewrites Antigravity's local session and nothing else.

Think of it as `gcloud config configurations`, but for Antigravity.

## Install

```bash
npm install -g @cruel-synthesis/agy-auth
```

Or try it without installing:

```bash
npx @cruel-synthesis/agy-auth --help
```

Requires Node.js 22 or later. Use the scoped name: the unscoped `agy-auth` on npm is an unrelated project.

## Quick start

```bash
# 1. Save the account Antigravity is signed in to right now
agy-auth add

# 2. Sign in to each of your other accounts in the browser
agy-auth login --alias work

# 3. Switch
agy-auth switch work        # by alias, email, or the number shown in `list`
agy-auth switch             # pick from a list
agy-auth -                  # back to the previous account
```

Then see where you stand:

```bash
agy-auth list               # every account, from the last saved reading
agy-auth list --refresh     # fetch live plan and quota first
agy-auth current            # the account in use
```

## What a switch changes

A switch changes which Google account Antigravity is signed in to. Your Antigravity settings, workspaces and conversations are shared by every account and stay as they are. Two settings follow the account: the Google Cloud project Google assigns it, and a model, if you saved one for it with `agy-auth model set`.

Each switch is journaled: the files it touches are snapshotted first and put back if a later step fails, and any part that could not be put back is reported.

<details>
<summary><b>See the account details view</b></summary>
<br>
<img src="https://raw.githubusercontent.com/cruel-synthesis/agy-auth/main/.github/assets/details.png" alt="agy-auth details showing an account's project, model, plan and quota meters" width="640">
</details>

## Let it choose

`agy-auth auto` ranks your accounts and switches to the one whose weekly quota is most likely to go unused before it resets. An account that is nearly spent is never chosen.

```bash
agy-auth auto --dry-run     # show the ranking and the choice, switch nothing
agy-auth auto               # switch to it
```

<details>
<summary><b>See the ranking</b></summary>
<br>
<img src="https://raw.githubusercontent.com/cruel-synthesis/agy-auth/main/.github/assets/auto.png" alt="agy-auth auto --dry-run ranking five accounts by quota at risk" width="760">
</details>

How the choice is made is explained in [docs/commands/auto.md](./docs/commands/auto.md).

## Responsible use

`agy-auth` is for moving between Google accounts **you own**. It is not a way around usage limits, and it never pools, proxies or shares quota between accounts.

Read Google's [Antigravity terms](https://antigravity.google/terms) before you use it. Section 6 says that using third-party software to access the service with Antigravity's OAuth is a breach of the agreement and may lead to suspension. Some `agy-auth` commands do exactly that, so here is what reaches Google and what doesn't:

| Command | Network |
|---|---|
| `switch`, `-`, `list`, `current`, `details`, `remove`, `alias`, `project`, `model`, `export`, `import`, `clean` | None. They read and write local files only. |
| `add` | One call to Google's `userinfo` endpoint to confirm which account the session belongs to. |
| `login` | A browser sign-in using Antigravity's OAuth client. |
| `list --refresh`, `current --refresh`, `details --refresh`, `list --check`, `auto` | Antigravity's undocumented quota endpoints, sent as the Antigravity app would send them, plus token renewal through Antigravity's client. Use `auto --offline` to rank on saved readings instead. |
| `doctor` | One reachability request to a Google API, skipped with `--offline`. |

Live quota is **off unless you ask for it**, and it is experimental. The endpoints are undocumented and may change or vanish. When that happens, `agy-auth` says the quota is unavailable and keeps showing your last reading; it never invents a number.

`agy-auth` is an independent project. It is **not affiliated with, endorsed by or supported by Google**.

## Privacy and security

- **Local only.** Accounts live in `~/.agy-auth/` with `0700` directories and `0600` files. There is no telemetry, no background process and no server.
- **Secrets stay redacted.** Account listings and `--json` output leave tokens out. `export --include-secrets` writes them only after asking.
- **Safe under concurrency.** File locks guard every write, and symlinked credential paths are refused.

Details are in [PRIVACY.md](./PRIVACY.md) and [SECURITY.md](./SECURITY.md).

## Platforms

| | macOS | Linux | Windows |
|---|---|---|---|
| Save, list, sign in | ✓ | ✓ | ✓ |
| Switch Antigravity's session | ✓ Keychain and token file | ✓ when Antigravity uses its token file | ✓ when Antigravity uses its token file |

On Linux and Windows, Antigravity may keep its sign-in in the system keyring, which `agy-auth` does not write yet. See [Platform support](./docs/platform-support.md).

## Commands

| Command | What it does |
|---|---|
| `agy-auth add` | Save the account Antigravity is signed in to |
| `agy-auth login` | Sign in to another account in the browser, or renew a saved one |
| `agy-auth list` (`ls`) | Show every account, plan and quota (`--refresh`, `--check`, `--active`, `--json`) |
| `agy-auth switch [account]` (`sw`) | Switch by number, alias or email, or pick from a list |
| `agy-auth -` | Switch back to the previous account |
| `agy-auth auto` (`best`) | Switch to the account with the most quota at risk (`--dry-run`, `--offline`, `--json`) |
| `agy-auth current` (`whoami`) | Show the account in use (`--refresh`, `--json`) |
| `agy-auth details [account]` (`info`) | Show everything saved for one account (`--refresh`, `--json`) |
| `agy-auth remove [account...]` | Remove saved accounts |
| `agy-auth alias \| project \| model <set\|clear>` | Name an account, or pin its GCP project or model |
| `agy-auth export [file]` / `import <file>` | Back up and restore saved accounts |
| `agy-auth doctor` | Check storage, registry and Antigravity session for problems |

Every command takes `--help`. The full reference is in [docs/commands](./docs/commands/README.md). Scripts can rely on `--json` envelopes and exit codes `0`, `1`, `2` and `130`; see the [JSON contract](./docs/json-contract.md).

## Contributing

```bash
npm ci
npm run check
```

Run the CLI against throwaway state, never your own:

```bash
root="$(mktemp -d)"
export AGY_AUTH_NO_NATIVE=1
export AGY_AUTH_HOME="${root}/.agy-auth"
export AGY_CLI_DIR="${root}/.gemini/antigravity-cli"
export AGY_SETTINGS_FILE="${AGY_CLI_DIR}/settings.json"
export AGY_TOKEN_FILE="${root}/token.json"
export AGY_GCLOUD_ADC_FILE="${root}/.config/gcloud/application_default_credentials.json"
npm run build && node ./bin/agy-auth.js --help
```

`AGY_AUTH_NO_NATIVE=1` is what keeps a run off the macOS Keychain; the paths alone do not. Add a regression test with each bug fix, and update the matching page under [docs/commands](./docs/commands/README.md) and the [changelog](./CHANGELOG.md) when behaviour changes. Report security issues privately, as described in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
