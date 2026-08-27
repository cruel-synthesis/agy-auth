import os from 'node:os';
import { input, password, select } from '@inquirer/prompts';
import { readAntigravityToken } from '../core/antigravity-store.js';
import { CredentialFiles } from '../core/credential-files.js';
import { isEmail } from '../core/credential-validation.js';
import { CancellationError, CliError, UsageError } from '../core/errors.js';
import { importKeychainOAuth } from '../core/keychain-import.js';
import type { AgyKeychainPayload } from '../core/keychain.js';
import { type AuthenticateOptions, OAuthFlow, type OAuthResult } from '../core/oauth.js';
import { Paths } from '../core/paths.js';
import { RegistryManager } from '../core/registry.js';
import type { Account } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';

const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const ALLOWED_METHODS = ['oauth', 'api-key', 'service-account', 'adc'] as const;
type AuthMethod = (typeof ALLOWED_METHODS)[number];

const ALLOWED_OAUTH_SOURCES = ['keychain', 'browser'] as const;
type OAuthSource = (typeof ALLOWED_OAUTH_SOURCES)[number];

export interface LoginOptions {
  method?: string;
  oauthSource?: string;
  alias?: string;
  project?: string;
  location?: string;
  model?: string;
  email?: string;
}

export interface LoginServices {
  authenticateOAuth?: (options?: AuthenticateOptions) => Promise<OAuthResult>;
  fetchFn?: typeof fetch;
}

export function validateEmailOrAlias(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return 'Please enter an email or alias.';
  if (isEmail(trimmed) || ALIAS_REGEX.test(trimmed)) return true;
  return 'Must be a valid email (user@example.com) or alias (alphanumeric, max 32 chars).';
}

export function validateAliasInput(val: string): boolean | string {
  const t = val.trim();
  if (!t) return true;
  return ALIAS_REGEX.test(t)
    ? true
    : 'Alias must be alphanumeric with underscores/hyphens (max 32 chars).';
}

export function validateApiKeyInput(val: string): boolean | string {
  return val.trim().length > 0 ? true : 'API key cannot be empty.';
}

export function validateServiceAccountPath(val: string): boolean | string {
  try {
    CredentialFiles.loadServiceAccountKeyFile(val.trim());
    return true;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid service account file';
  }
}

export async function loginCommand(
  options: LoginOptions = {},
  services?: LoginServices
): Promise<void> {
  if (options.method && !ALLOWED_METHODS.includes(options.method.toLowerCase() as AuthMethod)) {
    throw new UsageError(
      `Invalid authentication method "${options.method}". Allowed methods: ${ALLOWED_METHODS.join(', ')}`
    );
  }

  if (
    options.oauthSource &&
    !ALLOWED_OAUTH_SOURCES.includes(options.oauthSource.toLowerCase() as OAuthSource)
  ) {
    throw new UsageError(
      `Invalid OAuth source "${options.oauthSource}". Allowed sources: ${ALLOWED_OAUTH_SOURCES.join(', ')}`
    );
  }

  if (options.alias !== undefined) {
    const valid = validateAliasInput(options.alias);
    if (typeof valid === 'string') {
      throw new UsageError(`Invalid alias "${options.alias}": ${valid}`);
    }
  }

  console.log(`\n${colors.cyan('agy-auth')} - Add Credential Profile\n`);

  const registry = new RegistryManager();
  let chosenMethod: AuthMethod | undefined;
  let chosenOAuthSource: OAuthSource | undefined;

  if (!options.method && options.oauthSource) {
    chosenMethod = 'oauth';
    chosenOAuthSource = options.oauthSource.toLowerCase() as OAuthSource;
  } else if (options.method) {
    const normMethod = options.method.toLowerCase() as AuthMethod;
    if (normMethod === 'oauth') {
      chosenMethod = 'oauth';
      if (options.oauthSource) {
        chosenOAuthSource = options.oauthSource.toLowerCase() as OAuthSource;
      } else {
        if (os.platform() !== 'darwin') {
          throw new CliError(
            'Antigravity Keychain import is only supported on macOS. Use `--oauth-source browser` for browser OAuth or `agy-auth add` for non-OAuth credentials.',
            'unsupported_platform',
            1
          );
        }
        chosenOAuthSource = 'keychain';
      }
    } else {
      chosenMethod = normMethod;
    }
  } else {
    // 1. Direct auto-import on macOS when an importable Antigravity session exists
    if (os.platform() === 'darwin') {
      const tokenState = readAntigravityToken();
      if (tokenState.status === 'found') {
        const importResult = await importKeychainOAuth({
          email: options.email,
          alias: options.alias,
          project: options.project,
          location: options.location,
          model: options.model,
          fetchFn: services?.fetchFn,
          registry,
        });

        if (importResult.status === 'success') {
          const account = importResult.account;
          const verb = importResult.isNew
            ? 'Profile added successfully'
            : 'Profile updated successfully';
          console.log(
            `\n  ${colors.green('[ok]')} ${verb}: ${colors.green(formatAccountShort(account))}`
          );
          console.log(
            `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
          );
          return;
        }
      }
    }

    if (!process.stdin.isTTY) {
      throw new UsageError(
        'Interactive login requires a TTY. Pass `--oauth-source keychain` or `--oauth-source browser` explicitly.'
      );
    }

    const isMac = os.platform() === 'darwin';
    if (!isMac) {
      console.log(
        colors.dim(
          'Antigravity OAuth is macOS-only. Available authentication methods on this platform: API key, service account, and ADC.\n'
        )
      );
    }

    type MenuSelection = 'oauth-keychain' | 'api-key' | 'service-account' | 'adc';
    const choices = [
      ...(isMac
        ? [
            {
              name: 'Antigravity OAuth — import active macOS session',
              value: 'oauth-keychain' as MenuSelection,
              description: 'Import active Google session from Antigravity macOS Keychain',
            },
          ]
        : []),
      {
        name: 'Google Gemini API Key (recommended for direct API access)',
        value: 'api-key' as MenuSelection,
        description: 'Provide an API key from Google AI Studio',
      },
      {
        name: 'Google Cloud Service Account (JSON key file)',
        value: 'service-account' as MenuSelection,
        description: 'Provide the path to a Google Cloud IAM Service Account JSON key',
      },
      {
        name: 'Application Default Credentials (ADC)',
        value: 'adc' as MenuSelection,
        description: 'Use existing gcloud ADC or point to an ADC JSON file',
      },
    ];

    try {
      const selected = (await select({
        message: 'Select authentication method:',
        choices,
      })) as MenuSelection;

      if (selected === 'oauth-keychain') {
        chosenMethod = 'oauth';
        chosenOAuthSource = 'keychain';
      } else {
        chosenMethod = selected;
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ExitPromptError') {
        throw new CancellationError();
      }
      throw err;
    }
  }

  if (chosenMethod === 'oauth') {
    if (chosenOAuthSource === 'keychain') {
      let importResult = await importKeychainOAuth({
        email: options.email,
        alias: options.alias,
        project: options.project,
        location: options.location,
        model: options.model,
        fetchFn: services?.fetchFn,
        registry,
      });

      if (importResult.status === 'needs_email') {
        if (!process.stdin.isTTY) {
          throw new UsageError(
            'Could not derive email from Antigravity session. Specify `--email <email>`.'
          );
        }
        let promptEmail: string;
        try {
          promptEmail = await input({
            message: 'Enter the Google account email signed in to Antigravity:',
            validate: (v) => (isEmail(v.trim()) ? true : 'Please enter a valid email address.'),
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'ExitPromptError') {
            throw new CancellationError();
          }
          throw err;
        }

        importResult = await importKeychainOAuth({
          email: promptEmail.trim(),
          alias: options.alias,
          project: options.project,
          location: options.location,
          model: options.model,
          fetchFn: services?.fetchFn,
          registry,
        });
      }

      if (importResult.status === 'success') {
        const account = importResult.account;
        if (importResult.isNew) {
          console.log(
            `\n  ${colors.green('[ok]')} Profile added successfully: ${colors.green(formatAccountShort(account))}`
          );
        } else {
          console.log(
            `\n  ${colors.green('[ok]')} Profile updated successfully: ${colors.green(formatAccountShort(account))}`
          );
        }
        console.log(
          `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
        );
        return;
      }
    }

    if (chosenOAuthSource === 'browser') {
      const authFn = services?.authenticateOAuth || OAuthFlow.authenticate;
      const result = await authFn({ fetchFn: services?.fetchFn });

      const existing = registry
        .getAccounts()
        .find(
          (a) => a.authType === 'oauth' && a.email.toLowerCase() === result.email.toLowerCase()
        );

      const existingRefreshToken =
        existing?.credentials?.keychainPayload?.token?.refresh_token || '';

      const refreshToken = result.payload.token.refresh_token || existingRefreshToken || '';

      const payload: AgyKeychainPayload = {
        auth_method: 'consumer',
        token: {
          access_token: result.payload.token.access_token,
          token_type: result.payload.token.token_type || 'Bearer',
          refresh_token: refreshToken,
          expiry: result.payload.token.expiry,
        },
      };

      const account: Account = registry.addOrUpdateAccount({
        email: result.email,
        alias: options.alias !== undefined ? options.alias.trim() || undefined : existing?.alias,
        authType: 'oauth',
        status: 'valid',
        gcpProject:
          options.project !== undefined
            ? options.project.trim() || undefined
            : existing?.gcpProject,
        gcpLocation:
          options.location !== undefined
            ? options.location.trim() || undefined
            : existing?.gcpLocation,
        model: options.model !== undefined ? options.model.trim() || undefined : existing?.model,
        credentials: {
          keychainPayload: payload,
        },
      });

      if (existing) {
        console.log(
          `\n  ${colors.green('[ok]')} Profile updated successfully: ${colors.green(formatAccountShort(account))}`
        );
      } else {
        console.log(
          `\n  ${colors.green('[ok]')} Profile added successfully: ${colors.green(formatAccountShort(account))}`
        );
      }

      console.log(
        `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
      );
      return;
    }
  }

  if (chosenMethod === 'api-key') {
    let email: string;
    let alias: string | undefined = options.alias?.trim() || undefined;

    const identInput = await input({
      message: 'Enter email or profile alias for this API key:',
      validate: validateEmailOrAlias,
    });

    const trimmedIdent = identInput.trim();

    if (isEmail(trimmedIdent)) {
      email = trimmedIdent;
      if (!alias) {
        const aliasInput = await input({
          message: 'Enter optional alias (leave blank to skip):',
          validate: validateAliasInput,
        });
        alias = aliasInput.trim() || undefined;
      }
    } else {
      alias = alias || trimmedIdent;
      email = `${trimmedIdent.toLowerCase()}@local.invalid`;
    }

    const apiKey = await password({
      message: 'Enter Gemini API key:',
      mask: '*',
      validate: validateApiKeyInput,
    });

    const account = registry.addOrUpdateAccount({
      email,
      alias,
      authType: 'api-key',
      gcpProject: options.project?.trim() || undefined,
      gcpLocation: options.location?.trim() || undefined,
      model: options.model?.trim() || undefined,
      credentials: {
        apiKey: apiKey.trim(),
      },
      status: 'unverified',
    });

    console.log(
      `\n  ${colors.green('[ok]')} Profile added successfully: ${colors.green(formatAccountShort(account))}`
    );
    console.log(
      `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
    );
    return;
  }

  if (chosenMethod === 'service-account') {
    const saPath = await input({
      message: 'Path to Service Account JSON key file:',
      validate: validateServiceAccountPath,
    });

    const saKey = CredentialFiles.loadServiceAccountKeyFile(saPath.trim());

    let alias: string | undefined = options.alias?.trim() || undefined;
    if (!alias) {
      const aliasInput = await input({
        message: 'Enter optional alias (leave blank to skip):',
        validate: validateAliasInput,
      });
      alias = aliasInput.trim() || undefined;
    }

    const account = registry.addOrUpdateAccount({
      email: saKey.client_email,
      alias,
      authType: 'service-account',
      gcpProject: options.project?.trim() || saKey.project_id,
      gcpLocation: options.location?.trim() || undefined,
      model: options.model?.trim() || undefined,
      credentials: {
        serviceAccountKey: saKey,
      },
      status: 'unverified',
    });

    console.log(
      `\n  ${colors.green('[ok]')} Service Account added successfully: ${colors.green(formatAccountShort(account))}`
    );
    console.log(
      `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
    );
    return;
  }

  if (chosenMethod === 'adc') {
    const adcPathInput = await input({
      message: 'Path to ADC file (leave blank to use default gcloud location):',
    });

    const adcPath = adcPathInput.trim() || undefined;
    const targetAdcFile = adcPath || Paths.gcloudAdcFile;
    CredentialFiles.loadAdcFile(targetAdcFile);

    const identInput = await input({
      message: 'Enter email or profile alias for this ADC profile:',
      validate: validateEmailOrAlias,
    });

    const trimmedIdent = identInput.trim();
    let email: string;
    let alias: string | undefined = options.alias?.trim() || undefined;

    if (isEmail(trimmedIdent)) {
      email = trimmedIdent;
      if (!alias) {
        const aliasInput = await input({
          message: 'Enter optional alias (leave blank to skip):',
          validate: validateAliasInput,
        });
        alias = aliasInput.trim() || undefined;
      }
    } else {
      alias = alias || trimmedIdent;
      email = `${trimmedIdent.toLowerCase()}@local.invalid`;
    }

    const account = registry.addOrUpdateAccount({
      email,
      alias,
      authType: 'adc',
      gcpProject: options.project?.trim() || undefined,
      gcpLocation: options.location?.trim() || undefined,
      model: options.model?.trim() || undefined,
      credentials: { adcPath: targetAdcFile },
      status: 'unverified',
    });

    console.log(
      `\n  ${colors.green('[ok]')} ADC profile added successfully: ${colors.green(formatAccountShort(account))}`
    );
    console.log(
      `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate it.\n`
    );
  }
}
