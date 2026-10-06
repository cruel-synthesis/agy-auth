import fs from 'node:fs';
import path from 'node:path';
import { MAX_CREDENTIAL_FILE_SIZE } from './credential-files.js';
import { KeychainManager, parseAgyKeychainPayload } from './keychain.js';
import { Paths } from './paths.js';
import { Storage } from './storage.js';
import type { KeychainPayload } from './types.js';

type TokenStoreSource = 'keyring' | 'file';

interface AntigravityTokenReadResult {
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

interface AntigravityTokenWriteResult {
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
  let fd: number | null = null;
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
    if (stat.size > MAX_CREDENTIAL_FILE_SIZE) {
      return {
        status: 'error',
        message: `Token file exceeds maximum size of ${MAX_CREDENTIAL_FILE_SIZE} bytes.`,
      };
    }

    const flags =
      fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    fd = fs.openSync(tokenFile, flags);
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
      return {
        status: 'error',
        message: 'Token file changed while it was being opened.',
      };
    }
    if (openedStat.size > MAX_CREDENTIAL_FILE_SIZE) {
      return {
        status: 'error',
        message: `Token file exceeds maximum size of ${MAX_CREDENTIAL_FILE_SIZE} bytes.`,
      };
    }

    const content = fs.readFileSync(fd, 'utf-8');
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
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ELOOP') {
      return {
        status: 'error',
        message: 'Token path must be a regular file and not a symbolic link.',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      message: `Failed to read token file: ${msg}`,
    };
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
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
 *
 * Elsewhere only the file can be written, and Antigravity there may keep its
 * sign-in in Secret Service or Credential Manager instead, so the result warns
 * that the switch may not reach it.
 */
export function writeAntigravityToken(payload: KeychainPayload): AntigravityTokenWriteResult {
  const tokenFile = Paths.antigravityTokenFile;
  const parentDir = path.dirname(tokenFile);

  try {
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }
    const jsonStr = JSON.stringify(payload, null, 2);
    Storage.writeFileAtomic(tokenFile, jsonStr, 0o600);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      fileWritten: false,
      keyringWritten: false,
      error: `Failed to write token file: ${msg}`,
    };
  }

  if (!KeychainManager.isSupported()) {
    return {
      ok: true,
      fileWritten: true,
      keyringWritten: false,
      warning:
        "Only Antigravity's token file was updated; if Antigravity keeps its sign-in in this system's keyring, it stays on the previous account.",
    };
  }

  // On macOS Antigravity reads the Keychain item, so a switch that reaches only
  // the file would leave it on the previous account: fail and let the caller
  // restore the file.
  if (!KeychainManager.writeAgyToken(payload)) {
    return {
      ok: false,
      fileWritten: true,
      keyringWritten: false,
      error: "could not update Antigravity's Keychain item, so it stays on the previous account",
    };
  }

  return {
    ok: true,
    fileWritten: true,
    keyringWritten: true,
  };
}
