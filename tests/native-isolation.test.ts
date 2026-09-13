import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultOpenBrowser } from '../src/core/oauth.js';
import { KeychainManager } from '../src/core/keychain.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** The one file allowed to execute a credential-store binary. */
const CREDENTIAL_STORE_BOUNDARY = 'core/keychain.ts';

/**
 * A child-process call whose executable is written inline as a string literal.
 *
 * This is a text match, not static analysis: a command held in a variable,
 * built by concatenation, or reached through an indirection is invisible to it.
 * It catches the shape of the change that caused the incident, and nothing is
 * proven about the paths it cannot see.
 */
const CREDENTIAL_STORE_EXEC =
  /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*['"`](?:\/usr\/bin\/)?(?:security|secret-tool|cmdkey|keyring)\b/g;

function sourceFiles(dir: string = SRC_ROOT): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Redirecting HOME isolates file paths only. Native credential stores and
 * application launchers ignore it entirely, so an unmocked code path would
 * otherwise reach the developer's real Keychain, browser or IDE.
 */
describe('Native Operation Isolation', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    // Several cases here mock isSupported() to reach a platform-specific path.
    // Restoring centrally keeps a platform mock from leaking into a later test.
    vi.restoreAllMocks();
    testEnv.cleanup();
  });

  it('fails immediately when the native credential store is read without a test double', () => {
    // Mocked so the case tests the guard everywhere, rather than passing on
    // Linux and Windows because readAgyTokenState() returns early there.
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);

    expect(() => KeychainManager.readAgyTokenState()).toThrow(/native operation/i);
  });

  it('fails immediately when the native credential store is written without a test double', () => {
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    expect(() =>
      KeychainManager.writeAgyToken({
        auth_method: 'consumer',
        token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
      })
    ).toThrow(/native operation/i);
  });

  // Also proves the tolerant catch inside defaultOpenBrowser does not swallow a
  // breach: a launcher that merely fails is ignored, this one is not.
  it('fails immediately when a browser launch is attempted without a test double', () => {
    expect(() => defaultOpenBrowser('https://accounts.google.com/o/oauth2/v2/auth')).toThrow(
      /native operation/i
    );
  });

  it('still allows an explicitly installed execSecurity double', () => {
    const spy = vi
      .spyOn(KeychainManager, 'execSecurity')
      .mockReturnValue({ error: new Error('Missing'), status: 44 });
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);

    expect(KeychainManager.readAgyTokenState()).toEqual({ status: 'missing' });
    spy.mockRestore();
  });

  it('honours the double on the write path too, not just the read path', () => {
    // A guard repeated in a caller rather than kept at the single native
    // boundary fires even when a double is installed, which makes the double
    // useless and the write path untestable.
    const spy = vi.spyOn(KeychainManager, 'execSecurity').mockReturnValue({ stdout: '' });
    vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);

    expect(
      KeychainManager.writeAgyToken({
        auth_method: 'consumer',
        token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
      })
    ).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('keeps the guard in place after a test environment is torn down', () => {
    testEnv.cleanup();
    try {
      // The guard is set for the whole run, not per environment. Tearing an
      // environment down must not hand the rest of the file a native window.
      expect(process.env.AGY_AUTH_NO_NATIVE).toBe('1');
    } finally {
      testEnv = setupTestEnvironment();
    }
  });

  it('has no second literal credential-store call beside the guarded one', () => {
    // The Keychain overwrite happened because a second execution path was added
    // beside the guarded one and the tests doubling the first never saw it.
    // Written the same way, that change fails here rather than at runtime.
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const hits = fs.readFileSync(file, 'utf-8').match(CREDENTIAL_STORE_EXEC) ?? [];

      if (relative === CREDENTIAL_STORE_BOUNDARY) {
        expect(hits).toHaveLength(1);
      } else if (hits.length > 0) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps exactly one isolation check in that boundary file', () => {
    const boundary = fs.readFileSync(path.join(SRC_ROOT, CREDENTIAL_STORE_BOUNDARY), 'utf-8');
    expect(boundary.match(/assertNativeAllowed\(/g)).toHaveLength(1);
  });
});
