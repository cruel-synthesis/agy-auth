# project

Manage Google Cloud project and region settings for profiles.

```shell
agy-auth project set <account> <project> [location] [options]
agy-auth project clear <account> [options]
```

Options:

- `-j, --json`: Output result as JSON

Examples:

```shell
agy-auth project set 1 my-gcp-project us-central1
agy-auth project set work prod-ai-project
agy-auth project clear work
```

The project and location settings are saved to profile metadata and written to Antigravity `settings.json` when the profile is switched to active.
