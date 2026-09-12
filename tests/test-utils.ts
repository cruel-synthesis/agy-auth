import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { KeychainManager } from '../src/core/keychain.js';
import { Paths } from '../src/core/paths.js';
import type { KeychainPayload } from '../src/core/types.js';

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
  // Native stores and application launchers ignore HOME; block them explicitly.
  process.env.AGY_AUTH_NO_NATIVE = '1';

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
      AGY_TOKEN_FILE: tokenFile,
      AGY_GCLOUD_ADC_FILE: adcFile,
      AGY_AUTH_NO_NATIVE: '1',
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

export interface NativeStoreDouble {
  /** Payload the double currently holds, as production code would observe it. */
  readonly stored: KeychainPayload | null;
  restore: () => void;
}

/**
 * Installs an in-memory stand-in for the native credential store.
 *
 * `setupTestEnvironment` blocks real native access outright, so any test that
 * legitimately exercises a Keychain-backed path installs this instead. Reads and
 * writes then stay inside the test process and can be asserted on directly.
 */
export function installNativeStoreDouble(
  options: { supported?: boolean; initial?: KeychainPayload | null } = {}
): NativeStoreDouble {
  const supported = options.supported ?? true;
  let stored: KeychainPayload | null = options.initial ?? null;

  const spies = [
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(supported),
    vi.spyOn(KeychainManager, 'readAgyTokenState').mockImplementation(() => {
      if (!supported) return { status: 'unsupported' };
      return stored ? { status: 'found', payload: stored } : { status: 'missing' };
    }),
    vi.spyOn(KeychainManager, 'writeAgyToken').mockImplementation((payload) => {
      if (!supported) return false;
      stored = payload;
      return true;
    }),
    vi.spyOn(KeychainManager, 'deleteAgyToken').mockImplementation(() => {
      if (!supported) return false;
      stored = null;
      return true;
    }),
  ];

  return {
    get stored() {
      return stored;
    },
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/**
 * Node arguments that hold a spawned process to the same hermetic rules as the
 * runner. Every subprocess the suite launches must go through this.
 */
export function guardedNodeArgs(...args: string[]): string[] {
  const guard = fileURLToPath(new URL('./subprocess-guard.mjs', import.meta.url));
  return ['--import', guard, ...args];
}

/** One hour in milliseconds, for readable expiry fixtures. */
export const HOUR_MS = 3_600_000;

/**
 * An ISO timestamp offset from the current clock.
 *
 * Absolute fixtures such as `2030-01-01` silently encode "not yet expired".
 * They pass until the wall clock overtakes them and then invert the meaning of
 * every test that uses them, so expiry fixtures are always derived from now.
 */
export function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** An expiry comfortably in the future. */
export function futureExpiry(offsetMs: number = 24 * HOUR_MS): string {
  return isoFromNow(offsetMs);
}

/** An expiry already in the past. */
export function pastExpiry(offsetMs: number = 24 * HOUR_MS): string {
  return isoFromNow(-offsetMs);
}
