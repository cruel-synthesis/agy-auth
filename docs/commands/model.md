# model

Manage preferred Gemini model settings for profiles.

```shell
agy-auth model set <account> <model> [options]
agy-auth model clear <account> [options]
```

Options:

- `-j, --json`: Output result as JSON

Examples:

```shell
agy-auth model set 1 gemini-2.5-pro
agy-auth model set work gemini-2.5-flash
agy-auth model clear work
```

The preferred model is saved to profile metadata and written to Antigravity `settings.json` when the profile is activated.
