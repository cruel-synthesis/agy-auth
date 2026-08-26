# model

Manage preferred Gemini model settings for profiles.

```shell
agy-auth model set <account> <model> [options]
agy-auth model clear <account> [options]
```

Arguments:

- `account`: Account selector (number, email, ID, alias)
- `model`: Model name (e.g. `gemini-2.5-pro`)

Options:

- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

Examples:

```shell
agy-auth model set 1 gemini-2.5-pro
agy-auth model set work gemini-2.5-flash
agy-auth model clear work
```
