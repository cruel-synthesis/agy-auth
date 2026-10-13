import { UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { checkInputLength, sanitizeAccount } from '../core/types.js';
import { printJsonResult } from '../ui/format.js';
import { colors, marks } from '../ui/theme.js';

interface ModelOptions {
  json?: boolean;
}

export async function modelSetCommand(
  accountQuery: string,
  modelName: string,
  options: ModelOptions = {}
): Promise<void> {
  const registry = new RegistryManager();
  const account = registry.resolveAccount(accountQuery);
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
    printJsonResult('model set', {
      account: sanitizeAccount(updated),
      model: trimmedModel,
    });
    return;
  }

  console.log(
    `\n  ${marks.ok} Set default model '${colors.cyan(trimmedModel)}' for ${updated.email}`
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
  const account = registry.resolveAccount(accountQuery);
  // Clear both model and legacy reasoning effort
  registry.setModel(account.id, null, null);
  const updated = registry.findAccount(account.id);
  if (!updated) {
    throw new Error(`Failed to find account '${account.id}' after clearing model.`);
  }

  if (options.json) {
    printJsonResult('model clear', {
      account: sanitizeAccount(updated),
    });
    return;
  }

  console.log(`\n  ${marks.ok} Cleared default model for ${updated.email}\n`);
}
