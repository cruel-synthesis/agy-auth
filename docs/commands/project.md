# project

Manage Google Cloud Project settings for accounts.

```shell
agy-auth project set <account> <project> [location] [options]
agy-auth project clear <account> [options]
```

Arguments:

- `account`: Account selector (number, email, ID, alias)
- `project`: GCP project ID
- `location`: Optional compute region/location (positional)

Options:

- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

Examples:

```shell
# Set project and optional location
agy-auth project set 1 my-gcp-project us-central1
agy-auth project set work my-prod-project

# Clear project configuration
agy-auth project clear work
```
