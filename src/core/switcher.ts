import fs from 'node:fs';
import path from 'node:path';
import { writeAntigravityToken } from './antigravity-store.js';
import { type AdcDocument, CredentialFiles } from './credential-files.js';
import { validateServiceAccountKey } from './credential-validation.js';
import { AntigravitySettings } from './discovery.js';
import { MANAGED_ENV_VARS, shellEnvChanges } from './env-vars.js';
import { CliError, errorMessage } from './errors.js';
import { KeychainManager } from './keychain.js';
import { Paths } from './paths.js';
import { RegistryManager } from './registry.js';
import { READ_NO_FOLLOW, Storage, readSameFile } from './storage.js';
import { type Account, type SwitchResult, sanitizeAccount } from './types.js';

type FileSnapshot =
  | { readonly filePath: string; readonly existed: false }
  | {
      readonly filePath: string;
      readonly existed: true;
      readonly backupPath: string;
      readonly mode: number;
      readonly device: number;
      readonly inode: number;
      readonly backupDevice: number;
      readonly backupInode: number;
    };

/** Only a missing entry counts as absent; other lstat errors (EACCES, ENOTDIR) still throw. */
function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function captureFile(filePath: string, prefix: string, label: string): FileSnapshot {
  const original = lstatIfExists(filePath);
  if (!original) {
    return { filePath, existed: false };
  }
  if (original.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: '${filePath}'.`);
  }
  if (!original.isFile()) {
    throw new Error(`${label} must be a regular file: '${filePath}'.`);
  }

  const backupPath = Storage.createBackup(filePath, prefix);
  const backup = backupPath ? lstatIfExists(backupPath) : undefined;
  if (!backupPath || !backup) {
    throw new Error(`Could not create a durable backup of ${label} '${filePath}'. Switch aborted.`);
  }

  if (!backup.isFile()) {
    throw new Error(`Backup for ${label} '${filePath}' is not a regular file. Switch aborted.`);
  }

  // Reopen and compare identity: the backup must be the same file that was just
  // stat'd, not one swapped in since. `createBackup` already wrote it durably,
  // so this handle only reads.
  const backupFd = fs.openSync(backupPath, READ_NO_FOLLOW);
  try {
    const openedBackup = fs.fstatSync(backupFd);
    if (
      !openedBackup.isFile() ||
      openedBackup.dev !== backup.dev ||
      openedBackup.ino !== backup.ino
    ) {
      throw new Error(`Backup for ${label} '${filePath}' changed while it was being opened.`);
    }
  } finally {
    fs.closeSync(backupFd);
  }

  return {
    filePath,
    existed: true,
    backupPath,
    mode: original.mode & 0o7777,
    device: original.dev,
    inode: original.ino,
    backupDevice: backup.dev,
    backupInode: backup.ino,
  };
}

function restoreFile(snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    const current = lstatIfExists(snapshot.filePath);
    if (!current) return;
    if (current.isDirectory()) {
      throw new Error(`Cannot remove directory created at '${snapshot.filePath}'.`);
    }
    fs.unlinkSync(snapshot.filePath);
    return;
  }

  const observedBackup = lstatIfExists(snapshot.backupPath);
  if (!observedBackup) {
    throw new Error(`Rollback backup is missing for '${snapshot.filePath}'.`);
  }
  if (
    observedBackup.isSymbolicLink() ||
    !observedBackup.isFile() ||
    observedBackup.dev !== snapshot.backupDevice ||
    observedBackup.ino !== snapshot.backupInode
  ) {
    throw new Error(`Rollback backup changed for '${snapshot.filePath}'.`);
  }

  const content = readSameFile(snapshot.backupPath, {
    dev: snapshot.backupDevice,
    ino: snapshot.backupInode,
  });
  if (content === null) {
    throw new Error(`Rollback backup changed for '${snapshot.filePath}'.`);
  }
  Storage.writeFileAtomic(snapshot.filePath, content, snapshot.mode);
}

function readAntigravitySettings(snapshot: FileSnapshot): AntigravitySettings {
  if (!snapshot.existed) {
    if (lstatIfExists(snapshot.filePath)) {
      throw new Error('Antigravity settings changed after its rollback snapshot was created.');
    }
    return {};
  }

  const observed = fs.lstatSync(snapshot.filePath);
  if (
    observed.isSymbolicLink() ||
    !observed.isFile() ||
    observed.dev !== snapshot.device ||
    observed.ino !== snapshot.inode
  ) {
    throw new Error('Antigravity settings changed after its rollback snapshot was created.');
  }

  const content = readSameFile(snapshot.filePath, { dev: snapshot.device, ino: snapshot.inode });
  if (content === null) {
    throw new Error('Antigravity settings changed after its rollback snapshot was created.');
  }
  const raw = content.toString('utf-8');
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as AntigravitySettings;
}

export class Switcher {
  /**
   * Switches the active account with a full rollback journal.
   */
  static switchAccount(account: Account): SwitchResult {
    return Storage.withLockSync(Paths.switchLockFile, () => this.executeSwitch(account));
  }

  private static executeSwitch(targetAccount: Account): SwitchResult {
    const registry = new RegistryManager();

    const canonical = registry.findAccount(targetAccount.id);
    if (!canonical) {
      throw new CliError(
        `Account '${targetAccount.email}' (${targetAccount.id}) is not registered.`,
        'account_not_found',
        1
      );
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(canonical.id)) {
      throw new CliError(`Invalid account ID format '${canonical.id}'.`, 'invalid_account_id', 1);
    }

    if (canonical.authType === 'api-key') {
      const apiKey = canonical.credentials?.apiKey;
      if (!apiKey || !apiKey.trim()) {
        throw new CliError(
          `API key account '${canonical.email}' is missing its API key.`,
          'invalid_profile_credentials',
          1
        );
      }
    }

    if (canonical.authType === 'oauth') {
      const payload = canonical.credentials?.keychainPayload;
      if (!payload || !payload.token?.access_token || !payload.token?.access_token.trim()) {
        throw new CliError(
          `OAuth account '${canonical.email}' has invalid or missing access token.`,
          'invalid_profile_credentials',
          1
        );
      }
    }

    if (canonical.authType === 'service-account') {
      const saKey = canonical.credentials?.serviceAccountKey;
      if (!saKey) {
        throw new CliError(
          `Service account '${canonical.email}' is missing its key payload.`,
          'invalid_profile_credentials',
          1
        );
      }
      const validation = validateServiceAccountKey(saKey);
      if (!validation.ok) {
        throw new CliError(
          `Service account '${canonical.email}' has invalid credentials: ${validation.reason}`,
          'invalid_profile_credentials',
          1
        );
      }
    }

    let validatedAdc: AdcDocument | null = null;
    if (canonical.authType === 'adc') {
      const adcPath = canonical.credentials?.adcPath || Paths.gcloudAdcFile;
      try {
        validatedAdc = CredentialFiles.loadAdcFile(adcPath);
      } catch (err) {
        throw new CliError(
          `Invalid ADC credentials for account '${canonical.email}': ${errorMessage(err)}`,
          'invalid_profile_credentials',
          1
        );
      }
    }

    const previous = registry.getActiveAccount();
    Paths.ensureDirectories();

    const rollbackActions: Array<() => void> = [];
    const warnings: string[] = [];
    let antigravityUpdated = false;
    let adcUpdated = false;

    try {
      // 1. Snapshot and write token stores for OAuth
      if (canonical.authType === 'oauth') {
        const payload = canonical.credentials?.keychainPayload;
        if (!payload) {
          throw new CliError(
            `OAuth account '${canonical.email}' is missing its credential payload.`,
            'invalid_profile_credentials',
            1
          );
        }

        let keychainRollback: (() => void) | null = null;
        if (KeychainManager.isSupported()) {
          const keychainState = KeychainManager.readAgyTokenState();
          if (keychainState.status === 'error') {
            throw new CliError(
              `Cannot safely snapshot the existing Antigravity Keychain item: ${keychainState.message}`,
              'keychain_snapshot_failed',
              1
            );
          }
          if (keychainState.status === 'unsupported') {
            throw new CliError(
              'Cannot safely snapshot the existing Antigravity Keychain item on this platform.',
              'keychain_snapshot_failed',
              1
            );
          }
          if (keychainState.status === 'found') {
            const savedPayload = keychainState.payload;
            keychainRollback = () => {
              if (!KeychainManager.writeAgyToken(savedPayload)) {
                throw new Error('Failed to restore the Antigravity Keychain item.');
              }
            };
          } else {
            keychainRollback = () => {
              if (!KeychainManager.deleteAgyToken()) {
                throw new Error('Failed to remove the Antigravity Keychain item during rollback.');
              }
            };
          }
        }

        // Snapshot file half of composite store
        const tokenFilePath = Paths.antigravityTokenFile;
        const tokenFileSnapshot = captureFile(
          tokenFilePath,
          'switch_token',
          'Antigravity token file'
        );
        rollbackActions.push(() => restoreFile(tokenFileSnapshot));

        // Write both halves
        const writeResult = writeAntigravityToken(payload);
        if (!writeResult.ok) {
          throw new Error(
            `Failed to write session credentials: ${writeResult.error || 'file write failed'}`
          );
        }

        if (writeResult.keyringWritten && keychainRollback) {
          rollbackActions.push(keychainRollback);
        }

        if (writeResult.warning) {
          warnings.push(writeResult.warning);
        }
        antigravityUpdated = true;
      }

      // 2. Snapshot settings.json
      const settingsPath = Paths.antigravitySettingsFile;
      const settingsSnapshot = captureFile(settingsPath, 'switch_settings', 'Antigravity settings');
      rollbackActions.push(() => restoreFile(settingsSnapshot));

      // 3. Snapshot service-account file if needed
      let serviceAccountSnapshot: FileSnapshot | null = null;
      let serviceAccountPath: string | null = null;
      if (canonical.authType === 'service-account' && canonical.credentials?.serviceAccountKey) {
        serviceAccountPath = Paths.serviceAccountKeyFile(canonical.id);
        serviceAccountSnapshot = captureFile(
          serviceAccountPath,
          'switch_sa',
          'managed service-account credential'
        );
      }

      // 4. Snapshot ADC if needed
      let adcSnapshot: FileSnapshot | null = null;
      let sameAdcPath = false;
      if (canonical.authType === 'adc' && canonical.credentials?.adcPath && validatedAdc) {
        const canonicalAdc = path.resolve(canonical.credentials.adcPath);
        const targetAdc = path.resolve(Paths.gcloudAdcFile);
        sameAdcPath = canonicalAdc === targetAdc;
        if (!sameAdcPath) {
          adcSnapshot = captureFile(
            Paths.gcloudAdcFile,
            'switch_adc',
            'Application Default Credentials'
          );
        }
      }

      // 5. Apply settings.json updates
      const settingsDir = path.dirname(settingsPath);
      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
      }

      const currentSettings = readAntigravitySettings(settingsSnapshot);
      const newSettings: AntigravitySettings = { ...currentSettings };

      // Only values the account saves are written. The rest are the user's own
      // Antigravity choices, such as the model picked in its menu, and stay.
      if (canonical.gcpProject || canonical.gcpLocation) {
        newSettings.gcp = {
          ...(newSettings.gcp || {}),
          ...(canonical.gcpProject ? { project: canonical.gcpProject } : {}),
          ...(canonical.gcpLocation ? { location: canonical.gcpLocation } : {}),
        };
      }

      if (canonical.model) {
        newSettings.model = canonical.model;
      }

      Storage.writeJson(settingsPath, newSettings);
      antigravityUpdated = true;

      if (serviceAccountPath && canonical.credentials?.serviceAccountKey) {
        if (serviceAccountSnapshot) {
          const snapshot = serviceAccountSnapshot;
          rollbackActions.push(() => restoreFile(snapshot));
        }
        Storage.writeJson(serviceAccountPath, canonical.credentials.serviceAccountKey);
        adcUpdated = true;
      }

      if (canonical.authType === 'adc' && canonical.credentials?.adcPath) {
        if (!sameAdcPath) {
          if (adcSnapshot) {
            const snapshot = adcSnapshot;
            rollbackActions.push(() => restoreFile(snapshot));
          }
          Storage.writeJson(Paths.gcloudAdcFile, validatedAdc);
        }
        adcUpdated = true;
      }

      const activated = registry.setActiveAccount(canonical.id, canonical.updatedAt);
      if (!activated) {
        throw new Error(
          `Account '${canonical.email}' changed or was removed during the switch; external changes were rolled back.`
        );
      }

      return {
        previousAccount: previous ? sanitizeAccount(previous) : null,
        currentAccount: sanitizeAccount(activated),
        antigravityUpdated,
        adcUpdated,
        requiresShellUpdate: shellEnvChanges(previous ?? null, activated),
        managedEnvVars: MANAGED_ENV_VARS,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (let i = rollbackActions.length - 1; i >= 0; i--) {
        try {
          rollbackActions[i]();
        } catch (rollbackError) {
          rollbackErrors.push(errorMessage(rollbackError));
        }
      }

      if (rollbackErrors.length > 0) {
        const combined = new Error(
          `Account switch failed: ${errorMessage(error)} Rollback also failed: ${rollbackErrors.join('; ')}`
        );
        (combined as Error & { cause?: unknown }).cause = error;
        throw combined;
      }
      throw error;
    }
  }
}
