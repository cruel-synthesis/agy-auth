import { AccountNotFoundError, AmbiguousSelectorError, UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { checkInputLength, sanitizeAccount } from '../core/types.js';
import { colors } from '../ui/theme.js';

interface ProjectOptions {
  json?: boolean;
}

export async function projectSetCommand(
  accountQuery: string,
  projectId: string,
  location?: string,
  options: ProjectOptions = {}
): Promise<void> {
  const registry = new RegistryManager();
  const matches = registry.findAccounts(accountQuery);
  if (matches.length === 0) {
    throw new AccountNotFoundError(accountQuery);
  }
  if (matches.length > 1) {
    throw new AmbiguousSelectorError(
      accountQuery,
      matches.map((m) => m.alias || m.email)
    );
  }

  const account = matches[0];
  const trimmedProject = projectId.trim();
  if (!trimmedProject) {
    throw new UsageError('Project ID cannot be empty.');
  }
  checkInputLength('gcpProject', trimmedProject, 'Project ID');
  checkInputLength('gcpLocation', location?.trim(), 'Location');

  registry.setProject(account.id, trimmedProject, location);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after setting project.`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'project set',
          ok: true,
          data: {
            account: sanitizeAccount(updated),
            project: trimmedProject,
            location: updated.gcpLocation || null,
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `\n  ${colors.green('[ok]')} Set GCP project '${colors.cyan(trimmedProject)}' for ${updated.email}`
  );
  console.log(
    `  ${colors.dim('Note: Run `agy-auth switch` to apply these settings to your active Antigravity session.')}\n`
  );
}

export async function projectClearCommand(
  accountQuery: string,
  options: ProjectOptions = {}
): Promise<void> {
  const registry = new RegistryManager();
  const matches = registry.findAccounts(accountQuery);
  if (matches.length === 0) {
    throw new AccountNotFoundError(accountQuery);
  }
  if (matches.length > 1) {
    throw new AmbiguousSelectorError(
      accountQuery,
      matches.map((m) => m.alias || m.email)
    );
  }

  const account = matches[0];
  // Clear both project and location
  registry.setProject(account.id, null, null);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after clearing project.`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'project clear',
          ok: true,
          data: {
            account: sanitizeAccount(updated),
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n  ${colors.green('[ok]')} Cleared GCP project for ${updated.email}\n`);
}
