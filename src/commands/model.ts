import { AccountNotFoundError, AmbiguousSelectorError, UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { checkInputLength, sanitizeAccount } from '../core/types.js';
import { colors } from '../ui/theme.js';

interface ModelOptions {
  json?: boolean;
}

export async function modelSetCommand(
  accountQuery: string,
  modelName: string,
  options: ModelOptions = {}
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
  const trimmedModel = modelName.trim();
  if (!trimmedModel) {
    throw new UsageError('Model name cannot be empty.');
  }
  checkInputLength('model', trimmedModel, 'Model name');

  registry.setModel(account.id, trimmedModel);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after setting model.`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'model set',
          ok: true,
          data: {
            account: sanitizeAccount(updated),
            model: trimmedModel,
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `\n  ${colors.green('[ok]')} Set default model '${colors.cyan(trimmedModel)}' for ${updated.email}`
  );
  console.log(
    `  ${colors.dim('Note: Run `agy-auth switch` to apply these settings to your active Antigravity session.')}\n`
  );
}

export async function modelClearCommand(
  accountQuery: string,
  options: ModelOptions = {}
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
  // Clear both model and legacy reasoning effort
  registry.setModel(account.id, null, null);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after clearing model.`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'model clear',
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

  console.log(`\n  ${colors.green('[ok]')} Cleared default model for ${updated.email}\n`);
}
