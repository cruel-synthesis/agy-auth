# update

Update agy-auth to the latest version.

```shell
agy-auth update [options]
```

Options:

- `--check`: Only report whether a new version is available
- `-j, --json`: Report as JSON; never installs
- `-h, --help`: Show this help

`update` asks the npm registry (`registry.npmjs.org`) for the latest version, then upgrades with the tool that installed agy-auth:

| Installed with | Runs |
|---|---|
| Homebrew | `brew upgrade agy-auth` |
| npm | `npm install --global @cruel-synthesis/agy-auth@latest` |
| npx | Nothing; npx runs the latest version on its next start |
| Anything else, such as a source checkout | Nothing; it says a new version exists |

Saved accounts in `~/.agy-auth` are not touched.
