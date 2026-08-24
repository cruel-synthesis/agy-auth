import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Paths } from '../src/core/paths.js';

export interface TestEnv {
  dir: string;
  originalEnv: NodeJS.ProcessEnv;
  cleanup: () => void;
  createSubprocessEnv: () => Record<string, string>;
  assertPathInsideTestDir: (targetPath: string) => void;
}

export function generateSyntheticPrivateKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

export function setupTestEnvironment(): TestEnv {
  const originalEnv = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));

  const authHome = path.join(tempDir, '.agy-auth');
  const cliDir = path.join(tempDir, '.gemini', 'antigravity-cli');
  const settingsFile = path.join(cliDir, 'settings.json');
  const tokenFile = path.join(cliDir, 'antigravity-oauth-token');
  const adcFile = path.join(tempDir, '.config', 'gcloud', 'application_default_credentials.json');

  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.APPDATA = path.join(tempDir, 'AppData', 'Roaming');
  process.env.AGY_AUTH_HOME = authHome;
  process.env.AGY_CLI_DIR = cliDir;
  process.env.AGY_SETTINGS_FILE = settingsFile;
  process.env.AGY_TOKEN_FILE = tokenFile;
  process.env.AGY_GCLOUD_ADC_FILE = adcFile;

  // Initialize paths and ensure directories
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(path.dirname(adcFile), { recursive: true });
  Paths.ensureDirectories();

  const assertPathInsideTestDir = (targetPath: string) => {
    const resolved = path.resolve(targetPath);
    const resolvedRoot = path.resolve(tempDir);
    const relative = path.relative(resolvedRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(
        `Isolation breach: Path '${targetPath}' resolves outside test environment root '${tempDir}'.`
      );
    }
  };

  const createSubprocessEnv = (): Record<string, string> => {
    return {
      ...(process.env as Record<string, string>),
      HOME: tempDir,
      USERPROFILE: tempDir,
      APPDATA: path.join(tempDir, 'AppData', 'Roaming'),
      AGY_AUTH_HOME: authHome,
      AGY_CLI_DIR: cliDir,
      AGY_SETTINGS_FILE: settingsFile,
      AGY_GCLOUD_ADC_FILE: adcFile,
    };
  };

  const cleanup = () => {
    // Assert all writable paths remain inside tempDir
    assertPathInsideTestDir(Paths.authHome);
    assertPathInsideTestDir(Paths.registryFile);
    assertPathInsideTestDir(Paths.backupsDir);
    assertPathInsideTestDir(Paths.accountsDir);
    assertPathInsideTestDir(Paths.gcloudAdcFile);
    assertPathInsideTestDir(Paths.antigravitySettingsFile);

    // Restore environment
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }

    // Delete tempDir
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  };

  return {
    dir: tempDir,
    originalEnv,
    cleanup,
    createSubprocessEnv,
    assertPathInsideTestDir,
  };
}
