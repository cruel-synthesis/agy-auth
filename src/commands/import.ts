import { CredentialFiles } from '../core/credential-files.js';
import { validateAccountCredentials } from '../core/credential-validation.js';
import { UsageError } from '../core/errors.js';
import { RegistryManager, nextTimestamp } from '../core/registry.js';
import { Account, sanitizeAccount } from '../core/types.js';
import { colors, marks } from '../ui/theme.js';
import { printJsonResult } from '../ui/format.js';

interface ImportOptions {
  overwrite?: boolean;
  json?: boolean;
}

function findExisting(
  accounts: Account[],
  incoming: Account
): { byId?: Account; byIdentity?: Account } {
  const identityKey = `${incoming.email.toLowerCase()}\u0000${incoming.authType}`;
  return {
    byId: accounts.find((a) => a.id === incoming.id),
    byIdentity: accounts.find((a) => `${a.email.toLowerCase()}\u0000${a.authType}` === identityKey),
  };
}

function mergedCredentials(incoming: Account, existing: Account): Account['credentials'] {
  return incoming.credentials && Object.keys(incoming.credentials).length > 0
    ? incoming.credentials
    : existing.credentials;
}

export async function importCommand(filePath: string, options: ImportOptions = {}): Promise<void> {
  if (!filePath || !filePath.trim()) {
    throw new UsageError('File path is required. Usage: agy-auth import <file>');
  }

  const exportDoc = CredentialFiles.loadExportBackupFile(filePath.trim());
  const registry = new RegistryManager();
  const currentAccounts = registry.getAccounts();

  // Pre-validate all accounts before performing any mutations
  const aliases = new Map(currentAccounts.map((a) => [a.id, a.alias]));
  for (const rawAcc of exportDoc.accounts) {
    const { byId: existingById, byIdentity: existingByIdentity } = findExisting(
      currentAccounts,
      rawAcc
    );

    if (existingById && existingByIdentity && existingById.id !== existingByIdentity.id) {
      throw new UsageError(
        `Import conflict: account ID '${rawAcc.id}' matches one account but identity '${rawAcc.email}' (${rawAcc.authType}) matches another.`
      );
    }

    if (existingById && !existingByIdentity) {
      throw new UsageError(
        `ID collision for '${rawAcc.id}': incoming identity '${rawAcc.email}' (${rawAcc.authType}) differs from existing '${existingById.email}' (${existingById.authType}).`
      );
    }

    const existing = existingByIdentity || existingById;
    if (!existing) aliases.set(rawAcc.id, rawAcc.alias);
    else if (options.overwrite && rawAcc.alias !== undefined)
      aliases.set(existing.id, rawAcc.alias);

    if (!existing) {
      // New account must have complete, valid credentials
      const credVal = validateAccountCredentials(rawAcc);
      if (!credVal.ok) {
        throw new UsageError(
          `Cannot import new account '${rawAcc.email}' (${rawAcc.authType}) without credentials: ${credVal.reason}. Secret-free exports can only update existing accounts via --overwrite.`
        );
      }
    } else if (options.overwrite) {
      const credVal = validateAccountCredentials({
        authType: existing.authType,
        credentials: mergedCredentials(rawAcc, existing),
      });
      if (!credVal.ok) {
        throw new UsageError(
          `Invalid credentials for account '${rawAcc.email}' (${rawAcc.authType}): ${credVal.reason}`
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const alias of aliases.values()) {
    if (!alias) continue;
    if (seen.has(alias.toLowerCase())) {
      throw new UsageError(
        `Import would give two accounts the alias '${alias}'; rename one with \`agy-auth alias set\` first.`
      );
    }
    seen.add(alias.toLowerCase());
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

        const { byId: existingById, byIdentity: existingByIdentity } = findExisting(
          draft.accounts,
          acc
        );
        const existing = existingByIdentity || existingById;

        if (existing) {
          if (!options.overwrite) {
            skippedCount++;
            continue;
          }

          const existingIdx = draft.accounts.indexOf(existing);

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
            credentials: mergedCredentials(acc, existing),
            gcpProject: acc.gcpProject !== undefined ? acc.gcpProject : existing.gcpProject,
            gcpLocation: acc.gcpLocation !== undefined ? acc.gcpLocation : existing.gcpLocation,
            model: acc.model !== undefined ? acc.model : existing.model,
            reasoningEffort:
              acc.reasoningEffort !== undefined ? acc.reasoningEffort : existing.reasoningEffort,
            ...quotaFields,
            status: 'unverified',
            verification: undefined,
            updatedAt: nextTimestamp(existing.updatedAt),
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
    printJsonResult('import', {
      added: addedCount,
      updated: updatedCount,
      skipped: skippedCount,
      accounts: importedAccounts.map(sanitizeAccount),
    });
    return;
  }

  console.log(`\n  ${marks.ok} Import completed from: ${colors.cyan(filePath)}`);
  console.log(`    - Added:   ${colors.green(String(addedCount))}`);
  console.log(`    - Updated: ${colors.cyan(String(updatedCount))}`);
  console.log(`    - Skipped: ${colors.dim(String(skippedCount))}\n`);
}
