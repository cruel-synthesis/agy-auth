import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { assertNativeAllowed } from './native-guard.js';
import { type KeychainPayload, KeychainPayloadSchema } from './types.js';

export type AgyKeychainPayload = KeychainPayload;

export function parseAgyKeychainPayload(value: unknown): AgyKeychainPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  if (typeof raw.auth_method !== 'string' || raw.auth_method.trim().length === 0) {
    return null;
  }

  const result = KeychainPayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}

export type KeychainReadResult =
  | { status: 'found'; payload: AgyKeychainPayload }
  | { status: 'missing' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export class KeychainManager {
  private static readonly SERVICE_NAME = 'gemini';
  private static readonly ACCOUNT_NAME = 'antigravity';

  /**
   * Whether this build can read and write the Antigravity macOS Keychain item.
   */
  public static isSupported(): boolean {
    return os.platform() === 'darwin';
  }

  public static execSecurity(args: string[]): {
    stdout?: string;
    status?: number;
    error?: unknown;
  } {
    assertNativeAllowed('macOS Keychain access');

    try {
      const stdout = execFileSync('security', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout };
    } catch (error: unknown) {
      const status =
        error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
      return { error, status };
    }
  }

  /**
   * Reads Antigravity OAuth credentials from the macOS Keychain (0 network calls).
   */
  public static readAgyTokenState(): KeychainReadResult {
    if (!this.isSupported()) return { status: 'unsupported' };

    const res = this.execSecurity([
      'find-generic-password',
      '-s',
      this.SERVICE_NAME,
      '-a',
      this.ACCOUNT_NAME,
      '-w',
    ]);

    if (res.error) {
      if (res.status === 44) return { status: 'missing' };
      const message = res.error instanceof Error ? res.error.message : String(res.error);
      return { status: 'error', message };
    }

    const raw = (res.stdout || '').trim();
    if (!raw) return { status: 'missing' };

    const base64Str = raw.startsWith('go-keyring-base64:')
      ? raw.slice('go-keyring-base64:'.length)
      : raw;

    try {
      const jsonStr = Buffer.from(base64Str, 'base64').toString('utf-8');
      const payload: unknown = JSON.parse(jsonStr);
      const parsed = parseAgyKeychainPayload(payload);
      if (!parsed) {
        return {
          status: 'error',
          message: 'The Antigravity Keychain item has an invalid token payload.',
        };
      }
      return { status: 'found', payload: parsed };
    } catch {
      return {
        status: 'error',
        message: 'The Antigravity Keychain item is not valid JSON.',
      };
    }
  }

  /**
   * Writes the Antigravity OAuth token payload to the macOS Keychain.
   */
  public static writeAgyToken(payload: AgyKeychainPayload): boolean {
    const parsed = parseAgyKeychainPayload(payload);
    if (!parsed) return false;
    if (!this.isSupported()) return false;

    const jsonStr = JSON.stringify(parsed);
    const base64Str = Buffer.from(jsonStr, 'utf-8').toString('base64');
    const formatted = `go-keyring-base64:${base64Str}`;

    // `execSecurity` is the only place this class reaches the Keychain, so it is
    // also the only place the isolation guard belongs. Repeating the guard here
    // would fire even when a caller has installed an explicit double, and the
    // catch that used to wrap this block would have swallowed a real breach.
    const res = this.execSecurity([
      'add-generic-password',
      '-U',
      '-s',
      this.SERVICE_NAME,
      '-a',
      this.ACCOUNT_NAME,
      '-w',
      formatted,
    ]);
    return !res.error;
  }

  /**
   * Removes the Antigravity OAuth item from the macOS Keychain (used for switch rollback).
   */
  public static deleteAgyToken(): boolean {
    if (!this.isSupported()) return false;

    const res = this.execSecurity([
      'delete-generic-password',
      '-s',
      this.SERVICE_NAME,
      '-a',
      this.ACCOUNT_NAME,
    ]);
    return !res.error;
  }
}
