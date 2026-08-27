import fs from 'node:fs';
import path from 'node:path';
import { KeychainManager, parseAgyKeychainPayload } from './keychain.js';
import { Paths } from './paths.js';
import { Storage } from './storage.js';
import type { KeychainPayload } from './types.js';

export type TokenStoreSource = 'keyring' | 'file';

export interface AntigravityTokenReadResult {
  status: 'found' | 'missing' | 'unsupported' | 'error';
  payload?: KeychainPayload;
  source?: TokenStoreSource;
  warning?: string;
  keyringStatus: 'found' | 'missing' | 'unsupported' | 'error';
  keyringExpiry?: string;
  keyringPayload?: KeychainPayload;
  keyringMessage?: string;
  fileStatus: 'found' | 'missing' | 'error';
  fileExpiry?: string;
  filePayload?: KeychainPayload;
  fileMessage?: string;
}

export interface AntigravityTokenWriteResult {
  ok: boolean;
  fileWritten: boolean;
  keyringWritten: boolean;
  warning?: string;
  error?: string;
}

function parseIsoExpiry(expiry?: string): number | null {
  if (!expiry || typeof expiry !== 'string') return null;
  const parsed = Date.parse(expiry);
  return Number.isNaN(parsed) ? null : parsed;
}

function readFileToken(): {
  status: 'found' | 'missing' | 'error';
  payload?: KeychainPayload;
  expiry?: string;
  message?: string;
} {
  const tokenFile = Paths.antigravityTokenFile;
  try {
    if (!fs.existsSync(tokenFile)) {
      return { status: 'missing' };
    }

    const stat = fs.lstatSync(tokenFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        status: 'error',
        message: 'Token path must be a regular file and not a symbolic link.',
      };
    }

    const content = fs.readFileSync(tokenFile, 'utf-8');
    if (!content.trim()) {
      return { status: 'missing' };
    }

    const json: unknown = JSON.parse(content);
    const payload = parseAgyKeychainPayload(json);
    if (!payload) {
      return {
        status: 'error',
        message: 'Token file contains invalid or corrupted payload structure.',
      };
    }

    return {
      status: 'found',
      payload,
      expiry: payload.token.expiry,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      message: `Failed to read token file: ${msg}`,
    };
  }
}

/**
 * Reads Antigravity OAuth tokens from the composite store (system keyring and token file).
 * Compares expiries; the fresher half wins, with ties going to the keyring.
 * If one half is unparseable or errored, the other half is returned with a warning.
 */
export function readAntigravityToken(): AntigravityTokenReadResult {
  const keyringState = KeychainManager.readAgyTokenState();
  const fileState = readFileToken();

  let keyringStatus: 'found' | 'missing' | 'unsupported' | 'error' = 'missing';
  let keyringPayload: KeychainPayload | undefined;
  let keyringExpiry: string | undefined;
  let keyringMessage: string | undefined;

  if (keyringState.status === 'found') {
    keyringStatus = 'found';
    keyringPayload = keyringState.payload;
    keyringExpiry = keyringState.payload.token.expiry;
  } else if (keyringState.status === 'unsupported') {
    keyringStatus = 'unsupported';
  } else if (keyringState.status === 'error') {
    keyringStatus = 'error';
    keyringMessage = keyringState.message;
  } else {
    keyringStatus = 'missing';
  }

  const {
    status: fileStatus,
    payload: filePayload,
    expiry: fileExpiry,
    message: fileMessage,
  } = fileState;

  // Case 1: Both halves found
  if (keyringStatus === 'found' && fileStatus === 'found' && keyringPayload && filePayload) {
    const keyTime = parseIsoExpiry(keyringExpiry);
    const fileTime = parseIsoExpiry(fileExpiry);

    if (fileTime !== null && keyTime !== null) {
      if (fileTime > keyTime) {
        return {
          status: 'found',
          payload: filePayload,
          source: 'file',
          keyringStatus,
          keyringExpiry,
          keyringPayload,
          fileStatus,
          fileExpiry,
          filePayload,
        };
      }
      return {
        status: 'found',
        payload: keyringPayload,
        source: 'keyring',
        keyringStatus,
        keyringExpiry,
        keyringPayload,
        fileStatus,
        fileExpiry,
        filePayload,
      };
    }

    if (fileTime !== null && keyTime === null) {
      return {
        status: 'found',
        payload: filePayload,
        source: 'file',
        keyringStatus,
        keyringExpiry,
        keyringPayload,
        fileStatus,
        fileExpiry,
        filePayload,
      };
    }

    // Default tie / no parseable expiry -> keyring wins
    return {
      status: 'found',
      payload: keyringPayload,
      source: 'keyring',
      keyringStatus,
      keyringExpiry,
      keyringPayload,
      fileStatus,
      fileExpiry,
      filePayload,
    };
  }

  // Case 2: Only Keyring found
  if (keyringStatus === 'found' && keyringPayload) {
    const warning = fileStatus === 'error' ? fileMessage : undefined;
    return {
      status: 'found',
      payload: keyringPayload,
      source: 'keyring',
      warning,
      keyringStatus,
      keyringExpiry,
      keyringPayload,
      fileStatus,
      fileExpiry,
      filePayload,
      fileMessage,
    };
  }

  // Case 3: Only File found
  if (fileStatus === 'found' && filePayload) {
    const warning = keyringStatus === 'error' ? keyringMessage : undefined;
    return {
      status: 'found',
      payload: filePayload,
      source: 'file',
      warning,
      keyringStatus,
      keyringExpiry,
      keyringPayload,
      keyringMessage,
      fileStatus,
      fileExpiry,
      filePayload,
    };
  }

  // Case 4: Neither found
  if (keyringStatus === 'error' || fileStatus === 'error') {
    return {
      status: 'error',
      warning: keyringMessage || fileMessage,
      keyringStatus,
      keyringMessage,
      fileStatus,
      fileMessage,
    };
  }

  if (keyringStatus === 'unsupported' && fileStatus === 'missing') {
    return {
      status: 'unsupported',
      keyringStatus,
      fileStatus,
    };
  }

  return {
    status: 'missing',
    keyringStatus,
    fileStatus,
  };
}

/**
 * Writes Antigravity OAuth tokens to both halves of the composite store:
 * 1. File store at Paths.antigravityTokenFile (atomic write, mode 0600)
 * 2. System Keyring (macOS Keychain)
 */
export function writeAntigravityToken(payload: KeychainPayload): AntigravityTokenWriteResult {
  const tokenFile = Paths.antigravityTokenFile;
  const parentDir = path.dirname(tokenFile);

  let fileWritten = false;
  try {
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }
    const jsonStr = JSON.stringify(payload, null, 2);
    Storage.writeFileAtomic(tokenFile, jsonStr, 0o600);
    fileWritten = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      fileWritten: false,
      keyringWritten: false,
      error: `Failed to write token file: ${msg}`,
    };
  }

  let keyringWritten = false;
  if (KeychainManager.isSupported()) {
    keyringWritten = KeychainManager.writeAgyToken(payload);
  }

  if (!keyringWritten && KeychainManager.isSupported()) {
    return {
      ok: true,
      fileWritten: true,
      keyringWritten: false,
      warning: 'System keyring could not be updated; file store updated successfully.',
    };
  }

  return {
    ok: true,
    fileWritten: true,
    keyringWritten,
  };
}
