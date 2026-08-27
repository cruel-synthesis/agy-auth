import fs from 'node:fs';
import path from 'node:path';
import { readAntigravityToken } from '../core/antigravity-store.js';
import { CredentialFiles } from '../core/credential-files.js';
import { CliError } from '../core/errors.js';
import { KeychainManager } from '../core/keychain.js';
import { migrateRegistry } from '../core/migration.js';
import { Paths } from '../core/paths.js';
import { validateRegistry } from '../core/registry.js';
import { RegistrySchema, isRecord } from '../core/types.js';
import { colors } from '../ui/theme.js';

interface DoctorOptions {
  offline?: boolean;
  json?: boolean;
}

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const checks: CheckResult[] = [];

  // 1. Check storage directories (read-only)
  try {
    if (!fs.existsSync(Paths.authHome)) {
      checks.push({
        name: 'Storage Directories',
        status: 'ok',
        message:
          'Storage directory ~/.agy-auth not yet initialized (will be created on first profile add).',
      });
    } else {
      const stat = fs.lstatSync(Paths.authHome);
      if (stat.isSymbolicLink()) {
        checks.push({
          name: 'Storage Directories',
          status: 'fail',
          message: 'Storage path ~/.agy-auth is a symbolic link (must be a directory).',
        });
      } else if (!stat.isDirectory()) {
        checks.push({
          name: 'Storage Directories',
          status: 'fail',
          message: 'Storage path ~/.agy-auth is not a directory.',
        });
      } else if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
        checks.push({
          name: 'Storage Directory Permissions',
          status: 'warn',
          message: `~/.agy-auth permissions are 0${(stat.mode & 0o777).toString(8)}, expected 0700.`,
        });
      } else if (process.platform === 'win32') {
        checks.push({
          name: 'Storage Directories',
          status: 'ok',
          message: 'Storage directory exists; POSIX mode checks are not available on Windows.',
        });
      } else {
        checks.push({
          name: 'Storage Directories',
          status: 'ok',
          message: 'Storage directory exists with secure permissions.',
        });
      }
    }
  } catch (err) {
    checks.push({
      name: 'Storage Directories',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Check registry file and schema (strictly read-only)
  try {
    const legacyPath = path.join(Paths.authHome, 'accounts.json');
    if (!fs.existsSync(Paths.registryFile)) {
      if (fs.existsSync(legacyPath)) {
        checks.push({
          name: 'Registry Schema & Integrity',
          status: 'warn',
          message:
            'Legacy ~/.agy-auth/accounts.json detected. It is not imported automatically; back it up and copy it to ~/.agy-auth/registry.json with owner-only permissions before starting agy-auth.',
        });
      } else {
        checks.push({
          name: 'Registry Schema & Integrity',
          status: 'ok',
          message: 'Registry file not yet created (uninitialized state).',
        });
      }
    } else {
      const stat = fs.lstatSync(Paths.registryFile);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        checks.push({
          name: 'Registry Schema & Integrity',
          status: 'fail',
          message: 'Registry path must be a regular file and not a symbolic link.',
        });
      } else {
        if (process.platform !== 'win32') {
          const mode = stat.mode & 0o777;
          checks.push({
            name: 'Registry File Permissions',
            status: mode === 0o600 ? 'ok' : 'warn',
            message:
              mode === 0o600
                ? 'registry.json has mode 0600.'
                : `registry.json permissions are 0${mode.toString(8)}, expected 0600.`,
          });
        }

        const raw = fs.readFileSync(Paths.registryFile, 'utf-8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }

        if (!isRecord(parsed)) {
          checks.push({
            name: 'Registry Schema & Integrity',
            status: 'fail',
            message: 'Registry file contains malformed JSON or is not an object.',
          });
        } else if (parsed.schemaVersion !== 2) {
          try {
            const migrated = migrateRegistry(parsed);
            validateRegistry(migrated.registry);
            checks.push({
              name: 'Registry Schema & Integrity',
              status: 'warn',
              message: 'Legacy registry schema v1 detected (migration pending).',
            });
          } catch (migrateErr) {
            checks.push({
              name: 'Registry Schema & Integrity',
              status: 'fail',
              message: `Legacy registry format is incompatible: ${migrateErr instanceof Error ? migrateErr.message : String(migrateErr)}`,
            });
          }
        } else {
          const parsedResult = RegistrySchema.safeParse(parsed);
          if (!parsedResult.success) {
            checks.push({
              name: 'Registry Schema & Integrity',
              status: 'fail',
              message: `Registry Schema v2 validation failed: ${parsedResult.error.issues.map((i) => i.message).join(', ')}`,
            });
          } else {
            try {
              validateRegistry(parsedResult.data);
              checks.push({
                name: 'Registry Schema & Integrity',
                status: 'ok',
                message: `Registry Schema v2 valid (${parsedResult.data.accounts.length} account(s) registered).`,
              });
            } catch (validationError) {
              checks.push({
                name: 'Registry Schema & Integrity',
                status: 'fail',
                message: `Registry validation failed: ${formatError(validationError)}`,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    checks.push({
      name: 'Registry Schema & Integrity',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Check Antigravity session token storage (composite store)
  const tokenState = readAntigravityToken();
  if (KeychainManager.isSupported()) {
    if (tokenState.status === 'found') {
      const fileExp = tokenState.fileExpiry || 'no expiry';
      const keyExp = tokenState.keyringExpiry || 'no expiry';

      if (tokenState.source === 'file' && tokenState.keyringStatus === 'error') {
        checks.push({
          name: 'Antigravity Session Store',
          status: 'warn',
          message: `Active Antigravity session found in token file, but the system Keychain could not be read. ${tokenState.keyringMessage || tokenState.warning || 'Re-authenticate in Antigravity if the session stops working.'}`,
        });
      } else if (tokenState.source === 'file' && tokenState.keyringStatus === 'found') {
        checks.push({
          name: 'Antigravity Session Store',
          status: 'warn',
          message: `Re-authenticate in Antigravity if IDE session expires. Token file is fresher than system Keychain (file: ${fileExp}, Keychain: ${keyExp}; Keychain writes may be failing).`,
        });
      } else if (tokenState.source === 'file') {
        checks.push({
          name: 'Antigravity Session Store',
          status: 'ok',
          message: `No action needed. Active Antigravity session found in token file (expiry: ${fileExp}).`,
        });
      } else {
        checks.push({
          name: 'Antigravity Session Store',
          status: 'ok',
          message: `No action needed. Active Antigravity session found in system Keychain (expiry: ${keyExp}).`,
        });
      }
    } else if (tokenState.status === 'missing') {
      checks.push({
        name: 'Antigravity Session Store',
        status: 'warn',
        message: 'Sign in to Google Antigravity to create active session credentials.',
      });
    } else {
      checks.push({
        name: 'Antigravity Session Store',
        status: 'fail',
        message:
          `Re-authenticate in Google Antigravity to resolve corrupted session store. ${tokenState.warning || ''}`.trim(),
      });
    }
  } else {
    if (tokenState.status === 'found') {
      checks.push({
        name: 'Antigravity Session Store',
        status: 'ok',
        message: `No action needed. Active Antigravity session found in token file (expiry: ${tokenState.fileExpiry || 'no expiry'}).`,
      });
    } else {
      checks.push({
        name: 'Antigravity Session Store',
        status: 'warn',
        message: 'Sign in to Google Antigravity to create active session credentials.',
      });
    }
  }

  // 4. Check Antigravity Settings file
  try {
    if (fs.existsSync(Paths.antigravitySettingsFile)) {
      const stat = fs.lstatSync(Paths.antigravitySettingsFile);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('settings.json must be a regular file and not a symbolic link.');
      }
      const raw = fs.readFileSync(Paths.antigravitySettingsFile, 'utf-8');
      JSON.parse(raw);
      checks.push({
        name: 'Antigravity Settings File',
        status: 'ok',
        message: `Valid settings.json at ${Paths.antigravitySettingsFile}`,
      });
    } else {
      checks.push({
        name: 'Antigravity Settings File',
        status: 'warn',
        message: `settings.json not found at ${Paths.antigravitySettingsFile} (will be created on first switch).`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'Antigravity Settings File',
      status: 'fail',
      message: `Invalid settings.json: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. Check ADC file if present
  try {
    if (fs.existsSync(Paths.gcloudAdcFile)) {
      CredentialFiles.loadAdcFile(Paths.gcloudAdcFile);
      checks.push({
        name: 'Application Default Credentials (ADC)',
        status: 'ok',
        message: `Valid ADC file found at ${Paths.gcloudAdcFile}`,
      });
    } else {
      checks.push({
        name: 'Application Default Credentials (ADC)',
        status: 'ok',
        message: 'No global ADC file detected (optional).',
      });
    }
  } catch (err) {
    checks.push({
      name: 'Application Default Credentials (ADC)',
      status: 'warn',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Network Reachability Probe (optional)
  if (!options.offline) {
    try {
      const res = await fetch('https://generativelanguage.googleapis.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      });
      checks.push({
        name: 'Google API Reachability',
        status: 'ok',
        message: `Endpoint reachable (HTTP ${res.status}).`,
      });
    } catch {
      checks.push({
        name: 'Google API Reachability',
        status: 'warn',
        message: 'Could not reach Google API endpoint (offline or network restrictions).',
      });
    }
  }

  const hasFail = checks.some((c) => c.status === 'fail');

  if (options.json) {
    if (hasFail) {
      throw new CliError('One or more diagnostics checks failed.', 'doctor_failed', 1, {
        checks,
        passed: false,
      });
    }
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'doctor',
          ok: true,
          data: {
            checks,
            passed: true,
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n${colors.cyanBold('agy-auth Environment Diagnostics')}\n`);
  for (const c of checks) {
    let icon = colors.green('[ok]');
    if (c.status === 'warn') {
      icon = colors.yellow('[warn]');
    } else if (c.status === 'fail') {
      icon = colors.red('[fail]');
    }
    console.log(`  ${icon} ${c.name}`);
    console.log(`    ${colors.dim(c.message)}`);
  }
  console.log('');

  if (hasFail) {
    throw new CliError('One or more diagnostics checks failed.', 'doctor_failed', 1);
  }
}
