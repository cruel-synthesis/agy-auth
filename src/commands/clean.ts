import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../core/errors.js';
import { Paths } from '../core/paths.js';
import { MAX_BACKUP_RETENTION, managedBackupPrefix } from '../core/storage.js';
import { colors } from '../ui/theme.js';

interface CleanOptions {
  dryRun?: boolean;
  all?: boolean;
  json?: boolean;
}

export async function cleanCommand(options: CleanOptions = {}): Promise<void> {
  const backupsDir = Paths.backupsDir;
  if (!fs.existsSync(backupsDir)) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'clean',
            ok: true,
            data: {
              dryRun: Boolean(options.dryRun),
              removedFiles: [],
              keptFiles: [],
            },
          },
          null,
          2
        )
      );
      return;
    }
    console.log('No backup directory found. Nothing to clean.');
    return;
  }

  try {
    const stat = fs.lstatSync(backupsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('backup path must be a directory and must not be a symbolic link');
    }
  } catch (err) {
    throw new CliError(
      `Could not inspect the managed backup directory: ${err instanceof Error ? err.message : String(err)}`,
      'clean_failed',
      1
    );
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(backupsDir);
  } catch (err) {
    throw new CliError(
      `Could not read the managed backup directory: ${err instanceof Error ? err.message : String(err)}`,
      'clean_failed',
      1
    );
  }

  const managedFiles: Array<{ name: string; fullPath: string; mtimeMs: number; prefix: string }> =
    [];
  const inspectionFailures: string[] = [];

  for (const name of entries) {
    const prefix = managedBackupPrefix(name);
    if (!prefix) continue;

    const fullPath = path.join(backupsDir, name);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isFile()) {
        managedFiles.push({
          name,
          fullPath,
          mtimeMs: stat.mtimeMs,
          prefix,
        });
      }
    } catch {
      inspectionFailures.push(name);
    }
  }

  if (inspectionFailures.length > 0) {
    throw new CliError(
      `Could not inspect ${inspectionFailures.length} managed backup file(s).`,
      'clean_failed',
      1,
      { failedFiles: inspectionFailures }
    );
  }

  managedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // The quota is per backup kind, matching Storage.rotateBackups, so that
  // clearing out switch churn cannot also take the one copy of an account
  // written just before it was removed.
  const maxToKeep = options.all ? 0 : MAX_BACKUP_RETENTION;
  const keptPerPrefix = new Map<string, number>();
  const kept: typeof managedFiles = [];
  const toRemove: typeof managedFiles = [];

  for (const file of managedFiles) {
    const keptSoFar = keptPerPrefix.get(file.prefix) ?? 0;
    if (keptSoFar < maxToKeep) {
      keptPerPrefix.set(file.prefix, keptSoFar + 1);
      kept.push(file);
    } else {
      toRemove.push(file);
    }
  }

  const removedNames: string[] = [];
  const failedNames: string[] = [];

  for (const item of toRemove) {
    if (!options.dryRun) {
      try {
        fs.unlinkSync(item.fullPath);
        removedNames.push(item.name);
      } catch {
        failedNames.push(item.name);
      }
    } else {
      removedNames.push(item.name);
    }
  }

  if (failedNames.length > 0) {
    throw new CliError(
      `Could not remove ${failedNames.length} managed backup file(s).`,
      'clean_failed',
      1,
      { failedFiles: failedNames, removedFiles: removedNames }
    );
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'clean',
          ok: true,
          data: {
            dryRun: Boolean(options.dryRun),
            removedFiles: removedNames,
            keptFiles: kept.map((k) => k.name),
          },
        },
        null,
        2
      )
    );
    return;
  }

  const prefix = options.dryRun ? '[Dry Run] ' : '';
  console.log(
    `\n  ${colors.green('[ok]')} ${prefix}Cleaned ${removedNames.length} backup file(s) (retaining ${kept.length} newest backups).`
  );
  if (removedNames.length > 0) {
    for (const name of removedNames) {
      console.log(`    - ${colors.dim(name)}`);
    }
  }
  console.log('');
}
