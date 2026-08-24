# add

Add a credential profile from command-line arguments non-interactively.

```shell
agy-auth add [options]
```

Options:

- `--api-key <key>`: Gemini API key
- `--service-account <path>`: Path to Service Account JSON key file
- `--adc [path]`: Use Application Default Credentials (optional custom path)
- `--email <email>`: Account email address (or identifier for API-key profile)
- `--alias <alias>`: Unique account alias
- `--project <id>`: GCP project ID
- `--location <location>`: Compute region/location
- `--model <model>`: Preferred model name
- `-j, --json`: Output result as JSON envelope

ADC files may use the `authorized_user` or `service_account` credential type. External-account and Workload Identity Federation ADC files are not supported in v0.1.

Passing a real API key as `--api-key` can expose it through shell history or local process inspection. Prefer the masked `agy-auth login` prompt for manual use; reserve `add` for controlled automation.

Examples:

```shell
# Add Gemini API key profile
agy-auth add --email personal@example.com --api-key AIzaSy_MOCK_GEMINI_KEY_FOR_DOCS_00000 --alias personal

# Add Service Account profile
agy-auth add --email sa@project.iam.gserviceaccount.com --service-account /path/to/sa-key.json --alias sa-prod

# Add ADC profile
agy-auth add --email user@example.com --adc
```
