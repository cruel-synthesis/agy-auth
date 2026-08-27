# add

Add a credential profile from command-line options.

```shell
agy-auth add [options]
```

Options:

- `--api-key [key]`: Gemini API key; omit the value in a TTY for masked entry
- `--service-account <path>`: Path to Service Account JSON key file
- `--adc [path]`: Use Application Default Credentials (optional custom path)
- `--email <email>`: Account email address
- `--alias <alias>`: Account alias
- `--project <id>`: GCP project ID
- `--location <location>`: Compute region/location
- `--model <model>`: Preferred model name
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

Examples:

```shell
# Add a Gemini API key profile without placing the key in command arguments
agy-auth add --api-key --email developer@example.com --alias personal

# Add a Service Account JSON key profile
agy-auth add --email sa@project.iam.gserviceaccount.com --service-account /path/to/sa-key.json --alias sa-prod

# Add an ADC profile using default gcloud credentials
agy-auth add --email user@example.com --adc --alias gcloud-dev
```

For non-interactive use, pass the value as `--api-key <key>`. Be aware that command arguments may be retained in shell history or visible to other local processes.
