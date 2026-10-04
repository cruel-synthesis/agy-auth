import fs from 'node:fs';
import path from 'node:path';
import { readAntigravityToken } from '../core/antigravity-store.js';
import { CredentialFiles } from '../core/credential-files.js';
import { CliError, describeSchemaFailure, errorMessage } from '../core/errors.js';
import { KeychainManager } from '../core/keychain.js';
import { migrateRegistry } from '../core/migration.js';
import { Paths } from '../core/paths.js';
import { type QuotaProbe, probeQuotaEndpoints } from '../core/quota.js';
import { RegistryManager, validateRegistry } from '../core/registry.js';
import { CURRENT_SCHEMA_VERSION, RegistrySchema, isRecord } from '../core/types.js';
import { colors } from '../ui/theme.js';

interface DoctorOptions {
  offline?: boolean;
  json?: boolean;
  quota?: boolean;
}

/**
 * Ask the quota service directly and report what it said. The endpoints are
 * undocumented, so when a reading stops parsing this is the only way to tell a
 * changed contract from an account that simply has no quota.
 */
async function probeQuota(): Promise<QuotaProbe> {
  const registry = new RegistryManager();
  const active = registry.getActiveAccount();
  const account =
    active?.authType === 'oauth'
      ? active
      : registry.getAccounts().find((a) => a.authType === 'oauth');
  if (!account) {
    throw new Error('No Google sign-in account to probe; run `agy-auth add` to save one.');
  }
  return probeQuotaEndpoints(account);
}

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

/**
 * Where the Antigravity session lives, and whether it is usable.
 *
 * Separate from doctorCommand so that a credential store which refuses to be
 * read reports one failed check instead of ending the whole diagnosis.
 */
function checkSessionStore(): CheckResult {
  const name = 'Antigravity Session Store';
  const signIn = 'Sign in to Google Antigravity to create active session credentials.';
  const tokenState = readAntigravityToken();
  const selectedExpiry =
    tokenState.status === 'found' ? tokenState.payload?.token.expiry : undefined;
  const selectedExpiryMs = selectedExpiry ? Date.parse(selectedExpiry) : Number.NaN;

  if (Number.isFinite(selectedExpiryMs) && selectedExpiryMs <= Date.now()) {
    const source = tokenState.source === 'keyring' ? 'system Keychain' : 'token file';
    return {
      name,
      status: 'warn',
      message: `Antigravity session in ${source} expired at ${selectedExpiry}. Sign in to Google Antigravity again, then run \`agy-auth add\`.`,
    };
  }

  if (!KeychainManager.isSupported()) {
    if (tokenState.status !== 'found') {
      return { name, status: 'warn', message: signIn };
    }
    return {
      name,
      status: 'ok',
      message: `No action needed. Active Antigravity session found in token file (expiry: ${tokenState.fileExpiry || 'no expiry'}).`,
    };
  }

  if (tokenState.status === 'missing') {
    return { name, status: 'warn', message: signIn };
  }

  if (tokenState.status !== 'found') {
    return {
      name,
      status: 'fail',
      message:
        `Re-authenticate in Google Antigravity to resolve corrupted session store. ${tokenState.warning || ''}`.trim(),
    };
  }

  const fileExp = tokenState.fileExpiry || 'no expiry';
  const keyExp = tokenState.keyringExpiry || 'no expiry';
  const reauth = 'Re-authenticate in Antigravity if the session stops working.';

  if (tokenState.source === 'keyring' && tokenState.fileStatus === 'error') {
    return {
      name,
      status: 'warn',
      message: `Active Antigravity session found in system Keychain, but the token file could not be read. ${tokenState.fileMessage || tokenState.warning || reauth}`,
    };
  }

  if (tokenState.source === 'file' && tokenState.keyringStatus === 'error') {
    return {
      name,
      status: 'warn',
      message: `Active Antigravity session found in token file, but the system Keychain could not be read. ${tokenState.keyringMessage || tokenState.warning || reauth}`,
    };
  }

  if (tokenState.source === 'file' && tokenState.keyringStatus === 'found') {
    return {
      name,
      status: 'warn',
      message: `Re-authenticate in Antigravity if IDE session expires. Token file is fresher than system Keychain (file: ${fileExp}, Keychain: ${keyExp}; Keychain writes may be failing).`,
    };
  }

  if (tokenState.source === 'file') {
    return {
      name,
      status: 'ok',
      message: `No action needed. Active Antigravity session found in token file (expiry: ${fileExp}).`,
    };
  }

  return {
    name,
    status: 'ok',
    message: `No action needed. Active Antigravity session found in system Keychain (expiry: ${keyExp}).`,
  };
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const checks: CheckResult[] = [];

  // 1. Check storage directories (read-only)
  try {
    if (!fs.existsSync(Paths.authHome)) {
      checks.push({
        name: 'Storage Directories',
        status: 'ok',
        message: `Storage directory ${Paths.authHome} not yet initialized (will be created on first account add).`,
      });
    } else {
      const stat = fs.lstatSync(Paths.authHome);
      if (stat.isSymbolicLink()) {
        checks.push({
          name: 'Storage Directories',
          status: 'fail',
          message: `Storage path ${Paths.authHome} is a symbolic link (must be a directory).`,
        });
      } else if (!stat.isDirectory()) {
        checks.push({
          name: 'Storage Directories',
          status: 'fail',
          message: `Storage path ${Paths.authHome} is not a directory.`,
        });
      } else if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
        checks.push({
          name: 'Storage Directory Permissions',
          status: 'warn',
          message: `${Paths.authHome} permissions are 0${(stat.mode & 0o777).toString(8)}, expected 0700.`,
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
      message: errorMessage(err),
    });
  }

  // 2. Check registry file and schema (strictly read-only)
  let registryFd: number | null = null;
  try {
    const legacyPath = path.join(Paths.authHome, 'accounts.json');
    if (!fs.existsSync(Paths.registryFile)) {
      if (fs.existsSync(legacyPath)) {
        checks.push({
          name: 'Registry Schema & Integrity',
          status: 'warn',
          message: `Found ${legacyPath} from an early release, which this version cannot read. It is left untouched; run \`agy-auth add\` to save your accounts again.`,
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

        const flags =
          fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
        registryFd = fs.openSync(Paths.registryFile, flags);
        const openedStat = fs.fstatSync(registryFd);
        if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
          throw new Error('registry.json changed while it was being opened.');
        }

        const raw = fs.readFileSync(registryFd, 'utf-8');
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
        } else if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
          try {
            const migrated = migrateRegistry(parsed);
            validateRegistry(migrated.registry);
            checks.push({
              name: 'Registry Schema & Integrity',
              status: 'warn',
              message: `Registry uses schema ${parsed.schemaVersion}; it will be migrated to ${CURRENT_SCHEMA_VERSION} on the next command that saves.`,
            });
          } catch (migrateErr) {
            checks.push({
              name: 'Registry Schema & Integrity',
              status: 'fail',
              message: `Registry cannot be migrated: ${errorMessage(migrateErr)}`,
            });
          }
        } else {
          const parsedResult = RegistrySchema.safeParse(parsed);
          if (!parsedResult.success) {
            checks.push({
              name: 'Registry Schema & Integrity',
              status: 'fail',
              message: `Registry schema validation failed: ${describeSchemaFailure(parsedResult.error)}`,
            });
          } else {
            try {
              validateRegistry(parsedResult.data);
              checks.push({
                name: 'Registry Schema & Integrity',
                status: 'ok',
                message: `Registry schema ${CURRENT_SCHEMA_VERSION} valid (${parsedResult.data.accounts.length} account(s) registered).`,
              });
            } catch (validationError) {
              checks.push({
                name: 'Registry Schema & Integrity',
                status: 'fail',
                message: `Registry validation failed: ${errorMessage(validationError)}`,
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
      message: errorMessage(err),
    });
  } finally {
    if (registryFd !== null) {
      fs.closeSync(registryFd);
    }
  }

  // 3. Check Antigravity session token storage (composite store)
  try {
    checks.push(checkSessionStore());
  } catch (err) {
    checks.push({
      name: 'Antigravity Session Store',
      status: 'warn',
      message: `Session store could not be read: ${errorMessage(err)}`,
    });
  }

  // 4. Check Antigravity Settings file
  let settingsFd: number | null = null;
  try {
    if (fs.existsSync(Paths.antigravitySettingsFile)) {
      const stat = fs.lstatSync(Paths.antigravitySettingsFile);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('settings.json must be a regular file and not a symbolic link.');
      }
      const flags =
        fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
      settingsFd = fs.openSync(Paths.antigravitySettingsFile, flags);
      const openedStat = fs.fstatSync(settingsFd);
      if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
        throw new Error('settings.json changed while it was being opened.');
      }
      const raw = fs.readFileSync(settingsFd, 'utf-8');
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
      message: `Invalid settings.json: ${errorMessage(err)}`,
    });
  } finally {
    if (settingsFd !== null) {
      fs.closeSync(settingsFd);
    }
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
      message: errorMessage(err),
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

  let quotaProbe: QuotaProbe | undefined;
  if (options.quota) {
    // A probe that cannot start is one failed check, not the end of the report.
    try {
      quotaProbe = await probeQuota();
    } catch (err) {
      checks.push({ name: 'Quota Endpoint Probe', status: 'fail', message: errorMessage(err) });
    }
  }

  const hasFail = checks.some((c) => c.status === 'fail');

  if (options.json) {
    if (hasFail) {
      throw new CliError('One or more diagnostics checks failed.', 'doctor_failed', 1, {
        checks,
        passed: false,
        ...(quotaProbe ? { quotaProbe } : {}),
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
            ...(quotaProbe ? { quotaProbe } : {}),
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
  if (quotaProbe) {
    const renewal = quotaProbe.renewed ? 'token renewed' : 'token not renewed';
    console.log(
      `  ${colors.cyanBold('Quota endpoint probe')} (${quotaProbe.email}, credentials from ${quotaProbe.credentialSource}, ${renewal})`
    );
    for (const step of quotaProbe.steps) {
      const call = step.endpoint.split('/v1internal:')[1];
      console.log(`    ${step.client}  ${call}  ${step.request}  ${step.status}`);
      console.log(`      ${colors.dim(step.shape)}`);
    }
    const parsed = quotaProbe.parsed
      ? JSON.stringify(quotaProbe.parsed)
      : 'nothing the quota table can show';
    console.log(`    ${colors.dim(`parsed: ${parsed}`)}`);
  }

  console.log('');

  if (hasFail) {
    throw new CliError('One or more diagnostics checks failed.', 'doctor_failed', 1);
  }
}
