import { CredentialFiles } from '../core/credential-files.js';
import { isEmail } from '../core/credential-validation.js';
import { UsageError } from '../core/errors.js';
import { Paths } from '../core/paths.js';
import { RegistryManager } from '../core/registry.js';
import { AccountCredentials, AuthType, sanitizeAccount } from '../core/types.js';
import { formatAccountShort } from '../ui/format.js';
import { colors } from '../ui/theme.js';

const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

interface AddOptions {
  apiKey?: string;
  serviceAccount?: string;
  adc?: string | boolean;
  email?: string;
  alias?: string;
  project?: string;
  location?: string;
  model?: string;
  json?: boolean;
}

export async function addCommand(options: AddOptions): Promise<void> {
  const methodCount =
    (options.apiKey ? 1 : 0) +
    (options.serviceAccount ? 1 : 0) +
    (options.adc !== undefined ? 1 : 0);

  if (methodCount !== 1) {
    throw new UsageError(
      'Specify exactly one authentication method (--api-key <key>, --service-account <path>, or --adc [path]).'
    );
  }

  const alias = options.alias ? options.alias.trim() : undefined;
  if (alias && !ALIAS_REGEX.test(alias)) {
    throw new UsageError(
      `Invalid alias '${alias}'. Alias must start with alphanumeric and contain up to 32 alphanumeric, hyphen, or underscore characters.`
    );
  }

  let authType: AuthType;
  let email: string;
  let credentials: AccountCredentials | undefined;
  let defaultProject = options.project?.trim();

  if (options.apiKey) {
    authType = 'api-key';
    const key = options.apiKey.trim();
    if (!key) throw new UsageError('API key cannot be empty.');
    credentials = { apiKey: key };

    if (options.email) {
      const em = options.email.trim();
      if (!isEmail(em)) {
        throw new UsageError(`Invalid email address '${options.email}'.`);
      }
      email = em;
    } else if (alias) {
      email = `${alias.toLowerCase()}@local.invalid`;
    } else {
      throw new UsageError('API key profile requires --email <email> or --alias <alias>.');
    }
  } else if (options.serviceAccount) {
    authType = 'service-account';
    const saPath = options.serviceAccount.trim();
    if (!saPath) throw new UsageError('Service account file path cannot be empty.');
    const saKey = CredentialFiles.loadServiceAccountKeyFile(saPath);
    credentials = { serviceAccountKey: saKey };

    if (options.email) {
      const em = options.email.trim();
      if (!isEmail(em)) {
        throw new UsageError(`Invalid email address '${options.email}'.`);
      }
      if (em.toLowerCase() !== saKey.client_email.toLowerCase()) {
        throw new UsageError(
          `Provided --email '${options.email}' does not match service account client_email '${saKey.client_email}'.`
        );
      }
    }
    email = saKey.client_email;
    if (!defaultProject) {
      defaultProject = saKey.project_id;
    }
  } else {
    authType = 'adc';
    if (typeof options.adc === 'string' && options.adc.trim()) {
      const adcPath = options.adc.trim();
      CredentialFiles.loadAdcFile(adcPath);
      credentials = { adcPath };
    } else {
      CredentialFiles.loadAdcFile(Paths.gcloudAdcFile);
      credentials = { adcPath: Paths.gcloudAdcFile };
    }

    if (options.email) {
      const em = options.email.trim();
      if (!isEmail(em)) {
        throw new UsageError(`Invalid email address '${options.email}'.`);
      }
      email = em;
    } else if (alias) {
      email = `${alias.toLowerCase()}@local.invalid`;
    } else {
      throw new UsageError('ADC profile requires --email <email> or --alias <alias>.');
    }
  }

  const registry = new RegistryManager();
  const account = registry.addOrUpdateAccount({
    email,
    alias,
    authType,
    credentials,
    gcpProject: defaultProject,
    gcpLocation: options.location?.trim() || undefined,
    model: options.model?.trim() || undefined,
    status: 'unverified',
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'add',
          ok: true,
          data: {
            account: sanitizeAccount(account),
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `\n  ${colors.green('[ok]')} Profile added: ${colors.green(formatAccountShort(account))}`
  );
  console.log(
    `  Run ${colors.cyan(`agy-auth switch "${account.alias || account.email}"`)} to activate this profile.\n`
  );
}
