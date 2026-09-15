import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Paths } from './paths.js';

export const MAX_BACKUP_RETENTION = 10;

export const MANAGED_BACKUP_PREFIXES = [
  'schema_1_migration',
  'corrupt_registry_emergency',
  'switch_token',
  'switch_settings',
  'switch_adc',
  'switch_sa',
  'remove',
  'remove_all',
  'sync',
  'import',
  'clean',
  'backup',
] as const;

export type ManagedBackupPrefix = (typeof MANAGED_BACKUP_PREFIXES)[number];

export function isManagedBackupFileName(fileName: string): boolean {
  const hasManagedPrefix = MANAGED_BACKUP_PREFIXES.some((prefix) =>
    fileName.startsWith(`${prefix}_`)
  );
  return (
    hasManagedPrefix && /_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9]{8}$/.test(fileName)
  );
}

interface LockOwner {
  pid: number;
  token: string;
  fd: number | null;
}

export class CorruptedRegistryError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly backupPath: string | null,
    public readonly cause: unknown
  ) {
    super(
      `Corrupted registry file at ${filePath}. Emergency backup created at ${backupPath || 'none'}. Error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = 'CorruptedRegistryError';
  }
}

export class Storage {
  private static readonly lockRecoveryGraceMs = 100;
  private static readonly malformedLockRecoveryGraceMs = 30_000;
  private static readonly lockPollMinMs = 20;
  private static readonly lockPollMaxMs = 50;

  /**
   * Safely and atomically write JSON data to disk with 0600 permissions
   */
  static writeJson(filePath: string, data: unknown, pretty = true): void {
    const payload = pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data);
    this.writeFileAtomic(filePath, payload);
  }

  static writeFileAtomic(filePath: string, data: string | Buffer, mode = 0o600): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const tempPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd: number | null = null;

    try {
      fd = fs.openSync(tempPath, 'wx', mode);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, filePath);

      // Persist the directory entry when the platform supports directory fsync.
      let dirFd: number | null = null;
      try {
        dirFd = fs.openSync(dir, 'r');
        fs.fsyncSync(dirFd);
      } catch {
        // Windows and some filesystems do not permit fsync on directories.
      } finally {
        if (dirFd !== null) {
          try {
            fs.closeSync(dirFd);
          } catch {
            // The file contents and rename have already been persisted.
          }
        }
      }
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // ignore
      }
      throw err;
    }
  }

  /**
   * Executes an asynchronous action holding an exclusive file lock.
   */
  static async withLock<T>(
    lockFilePath: string,
    action: () => Promise<T>,
    timeoutMs = 15_000
  ): Promise<T> {
    const start = Date.now();
    const token = crypto.randomBytes(8).toString('hex');
    let owner: LockOwner | null = null;

    while (Date.now() - start < timeoutMs) {
      owner = this.acquireLock(lockFilePath, token);
      if (owner) break;

      this.recoverStaleLock(lockFilePath);

      const delay =
        Math.floor(Math.random() * (this.lockPollMaxMs - this.lockPollMinMs + 1)) +
        this.lockPollMinMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (!owner) {
      throw new Error(`Timeout acquiring lock on ${lockFilePath} after ${timeoutMs}ms`);
    }

    try {
      return await action();
    } finally {
      this.releaseLock(lockFilePath, owner);
    }
  }

  /**
   * Synchronously acquires a lock for synchronous CLI actions.
   */
  static withLockSync<T>(lockFilePath: string, action: () => T, timeoutMs = 15_000): T {
    const start = Date.now();
    const token = crypto.randomBytes(8).toString('hex');
    let owner: LockOwner | null = null;

    while (Date.now() - start < timeoutMs) {
      owner = this.acquireLock(lockFilePath, token);
      if (owner) break;

      this.recoverStaleLock(lockFilePath);

      const delay =
        Math.floor(Math.random() * (this.lockPollMaxMs - this.lockPollMinMs + 1)) +
        this.lockPollMinMs;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }

    if (!owner) {
      throw new Error(`Timeout acquiring lock on ${lockFilePath} after ${timeoutMs}ms`);
    }

    try {
      return action();
    } finally {
      this.releaseLock(lockFilePath, owner);
    }
  }

  private static acquireLock(lockFilePath: string, token: string): LockOwner | null {
    const dir = path.dirname(lockFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    try {
      const stat = fs.lstatSync(lockFilePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `Lock path '${lockFilePath}' exists but is not a regular file (symlink or directory).`
        );
      }
    } catch (statErr: unknown) {
      if (
        statErr &&
        typeof statErr === 'object' &&
        'code' in statErr &&
        (statErr.code === 'ENOENT' || statErr.code === 'ENOTDIR')
      ) {
        // Path does not exist yet (or was removed by concurrent lock release), safe to proceed
      } else {
        throw statErr;
      }
    }

    let fd: number | null = null;
    try {
      fd = fs.openSync(lockFilePath, 'wx', 0o600);
      const payload = JSON.stringify({
        pid: process.pid,
        time: Date.now(),
        token,
      });
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
      return { pid: process.pid, token, fd };
    } catch (err: unknown) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      if (err && typeof err === 'object' && 'code' in err) {
        // The lock is held; the caller retries until its own timeout.
        if (err.code === 'EEXIST') return null;
        // Windows refuses to open a file another process is deleting or holding,
        // reporting EPERM from CreateFile rather than EEXIST. That is contention,
        // not a permission fault: two concurrent mutations otherwise fail one of
        // them outright with a raw EPERM. A real permission problem still
        // surfaces, as the timeout naming this path.
        if (process.platform === 'win32' && err.code === 'EPERM') return null;
      }
      throw err;
    }
  }

  private static releaseLock(lockFilePath: string, owner: LockOwner): void {
    if (owner.fd !== null) {
      try {
        fs.closeSync(owner.fd);
      } catch {
        // ignore
      }
    }

    try {
      if (!fs.existsSync(lockFilePath)) return;
      const raw = fs.readFileSync(lockFilePath, 'utf-8');
      const data = JSON.parse(raw) as { token?: string; pid?: number };
      if (data.token === owner.token && data.pid === owner.pid) {
        fs.unlinkSync(lockFilePath);
      }
    } catch {
      // ignore
    }
  }

  private static recoverStaleLock(lockFilePath: string): void {
    try {
      if (!fs.existsSync(lockFilePath)) return;
      const stat = fs.lstatSync(lockFilePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        // Never call recursive removal on a lock path; non-regular lock paths must be rejected by acquireLock
        return;
      }

      const raw = fs.readFileSync(lockFilePath, 'utf-8');
      if (!raw.trim()) {
        if (Date.now() - stat.mtimeMs > this.malformedLockRecoveryGraceMs) {
          this.unlinkIfUnchanged(lockFilePath, raw, stat, null);
        }
        return;
      }

      let parsed: { pid?: unknown; time?: unknown; token?: unknown };
      try {
        parsed = JSON.parse(raw) as { pid?: unknown; time?: unknown; token?: unknown };
      } catch {
        if (Date.now() - stat.mtimeMs > this.malformedLockRecoveryGraceMs) {
          this.unlinkIfUnchanged(lockFilePath, raw, stat, null);
        }
        return;
      }

      const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
      const time = typeof parsed.time === 'number' ? parsed.time : undefined;
      const token = typeof parsed.token === 'string' ? parsed.token : null;

      if (pid === undefined || time === undefined) {
        if (Date.now() - stat.mtimeMs > this.malformedLockRecoveryGraceMs) {
          this.unlinkIfUnchanged(lockFilePath, raw, stat, token);
        }
        return;
      }

      if (pid === process.pid) return;

      const isDead = !this.isProcessAlive(pid);
      if (isDead && Date.now() - time > this.lockRecoveryGraceMs) {
        this.unlinkIfUnchanged(lockFilePath, raw, stat, token);
      }
    } catch {
      // ignore
    }
  }

  private static unlinkIfUnchanged(
    lockFilePath: string,
    observedRaw: string,
    observedStat: fs.Stats,
    token: string | null
  ): void {
    try {
      if (!fs.existsSync(lockFilePath)) return;
      const currentStat = fs.lstatSync(lockFilePath);
      if (
        !currentStat.isFile() ||
        currentStat.isSymbolicLink() ||
        currentStat.dev !== observedStat.dev ||
        currentStat.ino !== observedStat.ino ||
        currentStat.size !== observedStat.size
      ) {
        return;
      }
      const currentRaw = fs.readFileSync(lockFilePath, 'utf-8');
      if (currentRaw !== observedRaw) return;
      if (token !== null) {
        const parsed = JSON.parse(currentRaw) as { token?: unknown };
        if (parsed.token !== token) return;
      }
      fs.unlinkSync(lockFilePath);
    } catch {
      // ignore
    }
  }

  private static isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return !this.isCode(error, 'ESRCH');
    }
  }

  private static isCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
  }

  /**
   * Create an emergency backup before dangerous mutations or on corruption
   */
  static createBackup(sourcePath: string, prefix = 'backup'): string | null {
    let observedStat: fs.Stats;
    try {
      observedStat = fs.lstatSync(sourcePath);
    } catch {
      return null;
    }
    if (observedStat.isSymbolicLink() || !observedStat.isFile()) return null;

    Paths.ensureDirectories();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = path.basename(sourcePath);
    const suffix = crypto.randomBytes(4).toString('hex');
    const backupName = `${prefix}_${baseName}_${timestamp}_${suffix}`;
    const backupPath = path.join(Paths.backupsDir, backupName);

    let sourceFd: number | null = null;
    try {
      const flags =
        fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
      sourceFd = fs.openSync(sourcePath, flags);
      const openedStat = fs.fstatSync(sourceFd);
      if (
        !openedStat.isFile() ||
        openedStat.dev !== observedStat.dev ||
        openedStat.ino !== observedStat.ino
      ) {
        return null;
      }

      const content = fs.readFileSync(sourceFd);
      this.writeFileAtomic(backupPath, content);
      this.rotateBackups(Paths.backupsDir, MAX_BACKUP_RETENTION, backupPath);
      return backupPath;
    } catch {
      return null;
    } finally {
      if (sourceFd !== null) {
        fs.closeSync(sourceFd);
      }
    }
  }

  /**
   * Rotate backups to keep only the latest N managed backup files
   */
  static rotateBackups(dir: string, maxFiles = MAX_BACKUP_RETENTION, protectedPath?: string): void {
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs
        .readdirSync(dir)
        .filter((name) => isManagedBackupFileName(name))
        .map((f) => path.join(dir, f))
        .filter((f) => {
          try {
            const stat = fs.lstatSync(f);
            return stat.isFile() && !stat.isSymbolicLink();
          } catch {
            return false;
          }
        })
        .sort((a, b) => {
          if (a === protectedPath) return -1;
          if (b === protectedPath) return 1;
          try {
            const timeDelta = fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
            return timeDelta || b.localeCompare(a);
          } catch {
            return b.localeCompare(a);
          }
        });

      if (files.length > maxFiles) {
        for (let i = maxFiles; i < files.length; i++) {
          try {
            fs.unlinkSync(files[i]);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }
}
