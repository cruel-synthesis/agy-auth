import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class Paths {
  /**
   * Root directory for agy-auth data (~/.agy-auth or AGY_AUTH_HOME)
   */
  static get authHome(): string {
    const envPath = process.env.AGY_AUTH_HOME;
    if (envPath && envPath.trim() !== '') {
      return path.resolve(envPath);
    }
    return path.join(os.homedir(), '.agy-auth');
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
   * Directory for automated backups before switches / mutations
   */
  static get backupsDir(): string {
    return path.join(this.authHome, 'backups');
  }

  /**
   * Antigravity CLI base directory (~/.gemini/antigravity-cli or AGY_CLI_DIR)
   */
  static get antigravityCliDir(): string {
    if (process.env.AGY_CLI_DIR && process.env.AGY_CLI_DIR.trim() !== '') {
      return path.resolve(process.env.AGY_CLI_DIR);
    }
    return path.join(os.homedir(), '.gemini', 'antigravity-cli');
  }

  /**
   * Antigravity settings JSON (~/.gemini/antigravity-cli/settings.json or AGY_SETTINGS_FILE)
   */
  static get antigravitySettingsFile(): string {
    if (process.env.AGY_SETTINGS_FILE && process.env.AGY_SETTINGS_FILE.trim() !== '') {
      return path.resolve(process.env.AGY_SETTINGS_FILE);
    }
    return path.join(this.antigravityCliDir, 'settings.json');
  }

  /**
   * Antigravity token file (~/.gemini/antigravity-cli/antigravity-oauth-token or AGY_TOKEN_FILE)
   */
  static get antigravityTokenFile(): string {
    if (process.env.AGY_TOKEN_FILE && process.env.AGY_TOKEN_FILE.trim() !== '') {
      return path.resolve(process.env.AGY_TOKEN_FILE);
    }
    return path.join(this.antigravityCliDir, 'antigravity-oauth-token');
  }

  /**
   * Standard platform Google Cloud ADC location or AGY_GCLOUD_ADC_FILE override.
   */
  static get gcloudAdcFile(): string {
    if (process.env.AGY_GCLOUD_ADC_FILE && process.env.AGY_GCLOUD_ADC_FILE.trim() !== '') {
      return path.resolve(process.env.AGY_GCLOUD_ADC_FILE);
    }
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'gcloud', 'application_default_credentials.json');
    }
    return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  }

  /**
   * Google Cloud config directory (~/.config/gcloud or dirname(AGY_GCLOUD_ADC_FILE))
   */
  static get gcloudConfigDir(): string {
    if (process.env.AGY_GCLOUD_ADC_FILE && process.env.AGY_GCLOUD_ADC_FILE.trim() !== '') {
      return path.dirname(path.resolve(process.env.AGY_GCLOUD_ADC_FILE));
    }
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'gcloud');
    }
    return path.join(os.homedir(), '.config', 'gcloud');
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
        fs.chmodSync(dir, 0o700);
      }
    }
  }
}
