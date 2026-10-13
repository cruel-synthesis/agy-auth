import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Non-blank environment variable resolved to an absolute path, or undefined. */
function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? path.resolve(value) : undefined;
}

export class Paths {
  /**
   * Root directory for agy-auth data (~/.agy-auth or AGY_AUTH_HOME)
   */
  static get authHome(): string {
    return envPath('AGY_AUTH_HOME') ?? path.join(os.homedir(), '.agy-auth');
  }

  /**
   * Main registry file (~/.agy-auth/registry.json)
   */
  static get registryFile(): string {
    return path.join(this.authHome, 'registry.json');
  }

  /**
   * Registry lock file (~/.agy-auth/registry.lock)
   */
  static get registryLockFile(): string {
    return path.join(this.authHome, 'registry.lock');
  }

  /**
   * Lock used by account switches.
   */
  static get switchLockFile(): string {
    return path.join(this.authHome, 'switch.lock');
  }

  /**
   * Directory where per-account credentials and auth payloads are securely stored
   */
  static get accountsDir(): string {
    return path.join(this.authHome, 'accounts');
  }

  /**
   * Managed copy of a service-account key (~/.agy-auth/accounts/<id>.json)
   */
  static serviceAccountKeyFile(accountId: string): string {
    return path.join(this.accountsDir, `${path.basename(accountId)}.json`);
  }

  /**
   * Directory for automated backups before switches / mutations
   */
  static get backupsDir(): string {
    return path.join(this.authHome, 'backups');
  }

  /**
   * Antigravity CLI base directory (~/.gemini/antigravity-cli or AGY_CLI_DIR)
   */
  static get antigravityCliDir(): string {
    return envPath('AGY_CLI_DIR') ?? path.join(os.homedir(), '.gemini', 'antigravity-cli');
  }

  /**
   * Antigravity settings JSON (~/.gemini/antigravity-cli/settings.json or AGY_SETTINGS_FILE)
   */
  static get antigravitySettingsFile(): string {
    return envPath('AGY_SETTINGS_FILE') ?? path.join(this.antigravityCliDir, 'settings.json');
  }

  /**
   * Antigravity token file (~/.gemini/antigravity-cli/antigravity-oauth-token or AGY_TOKEN_FILE)
   */
  static get antigravityTokenFile(): string {
    return (
      envPath('AGY_TOKEN_FILE') ?? path.join(this.antigravityCliDir, 'antigravity-oauth-token')
    );
  }

  /**
   * Standard platform Google Cloud ADC location or AGY_GCLOUD_ADC_FILE override.
   */
  static get gcloudAdcFile(): string {
    const override = envPath('AGY_GCLOUD_ADC_FILE');
    if (override) return override;
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'gcloud', 'application_default_credentials.json');
    }
    return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  }

  /**
   * Ensure that essential directories exist with proper 0700 permissions
   */
  static ensureDirectories(): void {
    const dirs = [this.authHome, this.accountsDir, this.backupsDir];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        throw new Error(`agy-auth data directory must not be a symbolic link: '${dir}'.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`agy-auth data path must be a directory: '${dir}'.`);
      }
      if (process.platform !== 'win32') {
        let fd: number | null = null;
        try {
          fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const opened = fs.fstatSync(fd);
          if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
            throw new Error(`agy-auth data directory changed while it was being opened: '${dir}'.`);
          }
          fs.fchmodSync(fd, 0o700);
        } catch (error: unknown) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ELOOP') {
            throw new Error(`agy-auth data directory must not be a symbolic link: '${dir}'.`);
          }
          throw error;
        } finally {
          if (fd !== null) {
            fs.closeSync(fd);
          }
        }
      }
    }
  }
}
