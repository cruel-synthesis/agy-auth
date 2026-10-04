import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Paths } from '../src/core/paths.js';
import { Storage, isManagedBackupFileName } from '../src/core/storage.js';
import { setupTestEnvironment, TestEnv } from './test-utils.js';

describe('Storage and Concurrency Subsystem', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('performs atomic writes with 0600 file permissions and temp file cleanup', () => {
    const targetFile = path.join(testEnv.dir, 'atomic-target.json');
    const data = { hello: 'world', count: 42 };

    Storage.writeJson(targetFile, data);

    expect(fs.existsSync(targetFile)).toBe(true);
    const read = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    expect(read).toEqual(data);

    if (process.platform !== 'win32') {
      const stat = fs.statSync(targetFile);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    // Ensure no orphaned temp files remained
    const files = fs.readdirSync(testEnv.dir);
    const tempFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tempFiles).toEqual([]);
  });

  it('acquires and releases synchronous and asynchronous locks cleanly', async () => {
    const lockFile = path.join(testEnv.dir, 'test.lock');

    let syncExecuted = false;
    Storage.withLockSync(lockFile, () => {
      syncExecuted = true;
      expect(fs.existsSync(lockFile)).toBe(true);
    });
    expect(syncExecuted).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);

    let asyncExecuted = false;
    await Storage.withLock(lockFile, async () => {
      asyncExecuted = true;
      expect(fs.existsSync(lockFile)).toBe(true);
    });
    expect(asyncExecuted).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);

    // Releasing lock on synchronous error
    expect(() =>
      Storage.withLockSync(lockFile, () => {
        throw new Error('Sync error');
      })
    ).toThrow('Sync error');
    expect(fs.existsSync(lockFile)).toBe(false);

    // Releasing lock on asynchronous error
    await expect(
      Storage.withLock(lockFile, async () => {
        throw new Error('Async error');
      })
    ).rejects.toThrow('Async error');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('names the lock and how to clear it when it stays held', () => {
    const lockFile = path.join(testEnv.dir, 'held.lock');
    // This process's own PID is never treated as dead, so the lock stays held.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: Date.now(), token: 'x' }));

    expect(() => Storage.withLockSync(lockFile, () => {}, 100)).toThrow(
      `Another agy-auth command is holding ${lockFile}; if none is running, delete that file and try again.`
    );
  });

  it('rejects lock acquisition when lock path is a directory or symlink', () => {
    const dirLock = path.join(testEnv.dir, 'dir.lock');
    fs.mkdirSync(dirLock, { recursive: true });

    expect(() => Storage.withLockSync(dirLock, () => {})).toThrow(/not a regular file/);

    if (process.platform !== 'win32') {
      const targetDir = path.join(testEnv.dir, 'symlink-target');
      fs.mkdirSync(targetDir);
      const symlinkLock = path.join(testEnv.dir, 'symlink.lock');
      fs.symlinkSync(targetDir, symlinkLock);

      expect(() => Storage.withLockSync(symlinkLock, () => {})).toThrow(/not a regular file/);
    }
  });

  it('recovers from stale lock files held by dead PIDs without recursive deletion', async () => {
    const lockFile = path.join(testEnv.dir, 'stale.lock');
    const stalePayload = JSON.stringify({
      pid: 99999999, // guaranteed non-existent PID
      time: Date.now() - 100000,
      token: 'stale-token-123',
    });
    fs.writeFileSync(lockFile, stalePayload);

    let executed = false;
    await Storage.withLock(
      lockFile,
      async () => {
        executed = true;
      },
      3000
    );

    expect(executed).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('handles empty or malformed stale lock files gracefully after grace period', () => {
    const lockFile = path.join(testEnv.dir, 'malformed.lock');
    fs.writeFileSync(lockFile, 'not-valid-json');

    // Force mtime into the past
    const pastTime = new Date(Date.now() - 100000);
    fs.utimesSync(lockFile, pastTime, pastTime);

    let executed = false;
    Storage.withLockSync(
      lockFile,
      () => {
        executed = true;
      },
      3000
    );

    expect(executed).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('creates managed backups and rotates keeping only the newest 10', () => {
    expect(isManagedBackupFileName('sync_registry.json_2026-01-01T00-00-00-000Z_deadbeef')).toBe(
      true
    );
    expect(isManagedBackupFileName('backup_notes')).toBe(false);

    const sourceFile = path.join(testEnv.dir, 'data.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ version: 1 }));

    const createdBackups: string[] = [];
    for (let i = 0; i < 15; i++) {
      const backupPath = Storage.createBackup(sourceFile, `backup_${i}`);
      expect(backupPath).toBeTruthy();
      if (backupPath) createdBackups.push(backupPath);
    }

    Storage.rotateBackups(Paths.backupsDir, 10);
    const remaining = fs.readdirSync(Paths.backupsDir);
    expect(remaining.length).toBeLessThanOrEqual(10);
    expect(fs.existsSync(createdBackups.at(-1) as string)).toBe(true);

    // rotateBackups on non-existent dir
    Storage.rotateBackups(path.join(testEnv.dir, 'non-existent-dir'), 5);

    // createBackup on non-existent source
    expect(Storage.createBackup(path.join(testEnv.dir, 'missing-source.json'), 'pfx')).toBeNull();
  });

  it('does not follow a source symlink introduced while creating a backup', () => {
    if (process.platform === 'win32') return;

    const sourceFile = path.join(testEnv.dir, 'backup-source.json');
    const externalFile = path.join(testEnv.dir, 'external-source.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ source: true }));
    fs.writeFileSync(externalFile, JSON.stringify({ secret: 'must-not-be-backed-up' }));

    const ensureDirectories = Paths.ensureDirectories.bind(Paths);
    const ensureSpy = vi.spyOn(Paths, 'ensureDirectories').mockImplementation(() => {
      ensureDirectories();
      fs.unlinkSync(sourceFile);
      fs.symlinkSync(externalFile, sourceFile);
    });

    try {
      expect(Storage.createBackup(sourceFile, 'backup')).toBeNull();
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('classifies and rotates OAuth token switch backups as managed secrets', () => {
    expect(
      isManagedBackupFileName('switch_token_token.json_2026-01-01T00-00-00-000Z_deadbeef')
    ).toBe(true);

    const tokenFile = path.join(testEnv.dir, 'token.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'synthetic-token' }));

    for (let i = 0; i < 15; i++) {
      expect(Storage.createBackup(tokenFile, 'switch_token')).toBeTruthy();
    }

    const tokenBackups = fs
      .readdirSync(Paths.backupsDir)
      .filter((name) => name.startsWith('switch_token_'));
    expect(tokenBackups.length).toBeLessThanOrEqual(10);
  });
});
