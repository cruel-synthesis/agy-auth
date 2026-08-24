import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { UsageError } from '../core/errors.js';
import { RegistryManager } from '../core/registry.js';
import { Storage } from '../core/storage.js';
import { ExportDocumentV2, sanitizeAccounts } from '../core/types.js';
import { colors } from '../ui/theme.js';

interface ExportOptions {
  output?: string;
  includeSecrets?: boolean;
  yes?: boolean;
  json?: boolean;
}

export async function exportCommand(options: ExportOptions = {}): Promise<void> {
  const registry = new RegistryManager();
  const accounts = registry.getAccounts();

  if (options.includeSecrets && !options.yes) {
    if (!process.stdin.isTTY || options.json) {
      throw new UsageError('Exporting secrets in non-interactive or JSON mode requires --yes.');
    }
    const proceed = await confirm({
      message: 'Warning: Export will include API keys and OAuth tokens in plaintext. Proceed?',
      default: false,
    });
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }
  }

  const exportedAccounts = options.includeSecrets ? accounts : sanitizeAccounts(accounts);

  const exportDoc: ExportDocumentV2 = {
    kind: 'agy-auth-export',
    formatVersion: 2,
    registrySchemaVersion: 2,
    exportedAt: new Date().toISOString(),
    includesSecrets: Boolean(options.includeSecrets),
    accounts: exportedAccounts,
  };

  let targetPath: string;
  if (options.output) {
    targetPath = path.resolve(options.output);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      targetPath = path.join(targetPath, `agy-auth-export-${timestamp}.json`);
    }
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    targetPath = path.resolve(`agy-auth-export-${timestamp}.json`);
  }

  if (fs.existsSync(targetPath)) {
    throw new UsageError(
      `Export destination already exists: ${targetPath}. Destination will not be overwritten.`
    );
  }

  Storage.writeJson(targetPath, exportDoc);
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o600);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'export',
          ok: true,
          data: {
            destination: targetPath,
            accountCount: exportedAccounts.length,
            includesSecrets: Boolean(options.includeSecrets),
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `\n  ${colors.green('[ok]')} Exported ${exportedAccounts.length} account profile(s) to:`
  );
  console.log(`    ${colors.cyan(targetPath)}`);
  if (options.includeSecrets) {
    const protection =
      process.platform === 'win32' ? 'verify the destination ACLs' : 'file mode 0600';
    console.log(`    ${colors.yellow(`[warn] Contains plaintext credentials (${protection}).`)}`);
  }
  console.log('');
}
