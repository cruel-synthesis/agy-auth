import { CredentialFiles } from '../core/credential-files.js';
import {
  validateAccountCredentials,
  validateServiceAccountKey,
} from '../core/credential-validation.js';
import { UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { Account, sanitizeAccount } from '../core/types.js';
import { colors } from '../ui/theme.js';

interface ImportOptions {
  overwrite?: boolean;
  json?: boolean;
}

export async function importCommand(filePath: string, options: ImportOptions = {}): Promise<void> {
  if (!filePath || !filePath.trim()) {
    throw new UsageError('File path is required. Usage: agy-auth import <file>');
  }

  const exportDoc = CredentialFiles.loadExportBackupFile(filePath.trim());
  const registry = new RegistryManager();
  const currentAccounts = registry.getAccounts();

  // Pre-validate all accounts before performing any mutations
  for (const rawAcc of exportDoc.accounts) {
    const identityKey = `${rawAcc.email.toLowerCase()}\u0000${rawAcc.authType}`;
    const existingById = currentAccounts.find((a) => a.id === rawAcc.id);
    const existingByIdentity = currentAccounts.find(
      (a) => `${a.email.toLowerCase()}\u0000${a.authType}` === identityKey
    );

    if (existingById && existingByIdentity && existingById.id !== existingByIdentity.id) {
      throw new UsageError(
        `Import conflict: account ID '${rawAcc.id}' matches one profile but identity '${rawAcc.email}' (${rawAcc.authType}) matches another.`
      );
    }

    if (existingById && !existingByIdentity) {
      throw new UsageError(
        `ID collision for '${rawAcc.id}': incoming identity '${rawAcc.email}' (${rawAcc.authType}) differs from existing '${existingById.email}' (${existingById.authType}).`
      );
    }

    const existing = existingByIdentity || existingById;
    if (!existing) {
      // New account must have complete, valid credentials
      const credVal = validateAccountCredentials(rawAcc);
      if (!credVal.ok) {
        throw new UsageError(
          `Cannot import new account '${rawAcc.email}' (${rawAcc.authType}) without credentials: ${credVal.reason}. Secret-free exports can only update existing accounts via --overwrite.`
        );
      }
    } else if (options.overwrite) {
      const mergedCreds =
        rawAcc.credentials && Object.keys(rawAcc.credentials).length > 0
          ? rawAcc.credentials
          : existing.credentials;
      const credVal = validateAccountCredentials({
        authType: existing.authType,
        credentials: mergedCreds,
      });
      if (!credVal.ok) {
        throw new UsageError(
          `Invalid credentials for account '${rawAcc.email}' (${rawAcc.authType}): ${credVal.reason}`
        );
      }
    }
  }

  const importedAccounts: Account[] = [];
  let addedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  await registry.mutate(
    (draft) => {
      for (const rawAcc of exportDoc.accounts) {
        const acc: Account = {
          ...rawAcc,
          status: 'unverified',
          verification: undefined,
        };

        const identityKey = `${acc.email.toLowerCase()}\u0000${acc.authType}`;
        const existingById = draft.accounts.find((a) => a.id === acc.id);
        const existingByIdentity = draft.accounts.find(
          (a) => `${a.email.toLowerCase()}\u0000${a.authType}` === identityKey
        );

        const existing = existingByIdentity || existingById;

        if (existing) {
          if (!options.overwrite) {
            skippedCount++;
            continue;
          }

          const existingIdx = draft.accounts.findIndex((a) => a.id === existing.id);

          const mergedCredentials =
            acc.credentials && Object.keys(acc.credentials).length > 0
              ? acc.credentials
              : existing.credentials;

          // The quota cache is a timestamped measurement, so the fresher side
          // wins rather than whichever side happens to be the import.
          const importedQuotaIsNewer =
            acc.quotaCheckedAt !== undefined && acc.quotaCheckedAt > (existing.quotaCheckedAt ?? 0);
          const quotaFields = importedQuotaIsNewer
            ? { plan: acc.plan, rateLimit: acc.rateLimit, quotaCheckedAt: acc.quotaCheckedAt }
            : {
                plan: existing.plan ?? acc.plan,
                rateLimit: existing.rateLimit,
                quotaCheckedAt: existing.quotaCheckedAt,
              };

          const updated: Account = {
            ...existing,
            alias: acc.alias !== undefined ? acc.alias : existing.alias,
            credentials: mergedCredentials,
            gcpProject: acc.gcpProject !== undefined ? acc.gcpProject : existing.gcpProject,
            gcpLocation: acc.gcpLocation !== undefined ? acc.gcpLocation : existing.gcpLocation,
            model: acc.model !== undefined ? acc.model : existing.model,
            reasoningEffort:
              acc.reasoningEffort !== undefined ? acc.reasoningEffort : existing.reasoningEffort,
            ...quotaFields,
            status: 'unverified',
            verification: undefined,
            updatedAt: Math.max(Date.now(), (existing.updatedAt || 0) + 1),
          };

          draft.accounts[existingIdx] = updated;
          importedAccounts.push(updated);
          updatedCount++;
        } else {
          draft.accounts.push(acc);
          importedAccounts.push(acc);
          addedCount++;
        }
      }
    },
    { backupPrefix: 'import' }
  );

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'import',
          ok: true,
          data: {
            added: addedCount,
            updated: updatedCount,
            skipped: skippedCount,
            accounts: importedAccounts.map(sanitizeAccount),
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n  ${colors.green('[ok]')} Import completed from: ${colors.cyan(filePath)}`);
  console.log(`    - Added:   ${colors.green(String(addedCount))}`);
  console.log(`    - Updated: ${colors.cyan(String(updatedCount))}`);
  console.log(`    - Skipped: ${colors.dim(String(skippedCount))}\n`);
}
