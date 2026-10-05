import fs from 'node:fs';
import { CliError } from '../core/errors.js';
import { Paths } from '../core/paths.js';
import { BackupRetention, MAX_BACKUP_RETENTION, planBackupRetention } from '../core/storage.js';
import { colors, marks } from '../ui/theme.js';

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

  let plan: BackupRetention;
  try {
    plan = planBackupRetention(backupsDir, options.all ? 0 : MAX_BACKUP_RETENTION);
  } catch (err) {
    throw new CliError(
      `Could not read the managed backup directory: ${err instanceof Error ? err.message : String(err)}`,
      'clean_failed',
      1
    );
  }

  if (plan.unreadable.length > 0) {
    throw new CliError(
      `Could not inspect ${plan.unreadable.length} managed backup file(s).`,
      'clean_failed',
      1,
      { failedFiles: plan.unreadable }
    );
  }

  const kept = plan.keep;
  const toRemove = plan.remove;

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

  const rule = options.all ? '' : ` (the newest ${MAX_BACKUP_RETENTION} of each kind)`;
  const summary = options.dryRun
    ? `[Dry Run] Would remove ${removedNames.length} backup file(s) and keep ${kept.length}${rule}.`
    : `Removed ${removedNames.length} backup file(s); kept ${kept.length}${rule}.`;
  console.log(`\n  ${marks.ok} ${summary}`);
  if (removedNames.length > 0) {
    for (const name of removedNames) {
      console.log(`    - ${colors.dim(name)}`);
    }
  }
  console.log('');
}
