import path from 'node:path';
import { UsageError } from '../core/errors.js';
import { Paths } from '../core/paths.js';
import { RegistryManager } from '../core/registry.js';

interface EnvOptions {
  shell?: string;
  clear?: boolean;
  json?: boolean;
}

export function escapePosix(value: string): string {
  // POSIX single-quote escaping: replace ' with '\'''
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function escapePowerShell(value: string): string {
  // PowerShell single-quote escaping: replace ' with ''
  return `'${value.replace(/'/g, "''")}'`;
}

export function generateEnvStatements(
  envVars: Record<string, string | null>,
  shellType: 'posix' | 'powershell'
): string[] {
  const statements: string[] = [];

  for (const [key, val] of Object.entries(envVars)) {
    if (val === null || val === '') {
      if (shellType === 'powershell') {
        statements.push(`Remove-Item Env:${key} -ErrorAction SilentlyContinue`);
      } else {
        statements.push(`unset ${key}`);
      }
    } else {
      if (shellType === 'powershell') {
        statements.push(`$env:${key} = ${escapePowerShell(val)}`);
      } else {
        statements.push(`export ${key}=${escapePosix(val)}`);
      }
    }
  }

  return statements;
}

export async function envCommand(options: EnvOptions = {}): Promise<void> {
  const defaultShell = process.platform === 'win32' ? 'powershell' : 'posix';
  const rawShell = options.shell ? options.shell.toLowerCase() : defaultShell;

  if (
    rawShell !== 'posix' &&
    rawShell !== 'powershell' &&
    rawShell !== 'bash' &&
    rawShell !== 'zsh'
  ) {
    throw new UsageError(
      `Unsupported shell format '${options.shell}'. Supported formats: posix, powershell.`
    );
  }

  const shellType: 'posix' | 'powershell' = rawShell === 'powershell' ? 'powershell' : 'posix';

  const registry = new RegistryManager();
  const active = registry.getActiveAccount();

  if (!options.clear && !active) {
    throw new UsageError(
      'No active profile configured. Run `agy-auth switch <profile>` to select an active profile or `agy-auth env --clear` to reset environment variables.'
    );
  }

  const envVars: Record<string, string | null> = {
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
    GOOGLE_APPLICATION_CREDENTIALS: null,
    GOOGLE_CLOUD_PROJECT: null,
    GOOGLE_CLOUD_LOCATION: null,
  };

  if (!options.clear && active) {
    if (active.gcpProject) {
      envVars.GOOGLE_CLOUD_PROJECT = active.gcpProject;
    }
    if (active.gcpLocation) {
      envVars.GOOGLE_CLOUD_LOCATION = active.gcpLocation;
    }

    if (active.authType === 'api-key' && active.credentials?.apiKey) {
      envVars.GEMINI_API_KEY = active.credentials.apiKey;
      envVars.GOOGLE_API_KEY = active.credentials.apiKey;
    }

    if (active.authType === 'service-account' && active.credentials?.serviceAccountKey) {
      const saPath = path.join(Paths.accountsDir, `${path.basename(active.id)}.json`);
      envVars.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'env',
          ok: true,
          data: {
            shell: shellType,
            containsSecrets: true,
            variables: envVars,
          },
        },
        null,
        2
      )
    );
    return;
  }

  const lines = generateEnvStatements(envVars, shellType);
  if (lines.length > 0) {
    console.log(lines.join('\n'));
  }
}
