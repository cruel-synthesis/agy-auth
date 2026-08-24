# login

Add or refresh a credential profile interactively or via CLI options.

```shell
agy-auth login [options]
```

Options:

- `--method <method>`: Authentication method (`oauth`, `api-key`, `service-account`, `adc`)
- `--oauth-source <source>`: OAuth onboarding source (`keychain`, `browser`)
- `--email <email>`: Account email address (used for Keychain import fallback)
- `--alias <alias>`: Profile alias
- `--project <id>`: GCP project ID
- `--location <location>`: Compute region/location
- `--model <model>`: Preferred model name

Supported methods:

1. **OAuth Onboarding (`oauth`)**:
   - **Antigravity macOS Keychain (`--oauth-source keychain`)** *(Default on macOS)*:
     Imports the active official Google Antigravity session from the macOS Keychain. Automatically derives and verifies the account email via Google's userinfo endpoint using the access token. Does not require setting `AGY_OAUTH_CLIENT_ID`. If the profile already exists, updates the stored access token while preserving the existing refresh token and metadata.
   - **Custom Google Browser Sign-In (`--oauth-source browser`)**:
     Initiates a local PKCE OAuth 2.0 flow on `127.0.0.1` using a user-supplied Google Cloud Desktop OAuth Client ID. Requires setting the `AGY_OAUTH_CLIENT_ID` environment variable (and optionally `AGY_OAUTH_CLIENT_SECRET`).

2. **Google Gemini API Key (`api-key`)**:
   Prompts for a masked API key from Google AI Studio, an optional email identifier, and an alias.

3. **Google Cloud Service Account (`service-account`)**:
   Prompts for the path to a Google Cloud IAM Service Account JSON key file and an optional alias.

4. **Application Default Credentials (`adc`)**:
   Prompts for the ADC JSON file path, email identity, and an alias.

To add API key, service account, or ADC profiles non-interactively in scripts, use `agy-auth add [options]`.
To discover all local active credentials at once, use `agy-auth sync`.
