import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { validateAdcDocument, validateServiceAccountKey } from './credential-validation.js';
import { migrateExportDocument } from './migration.js';
import { ExportDocumentV2, ServiceAccountKey, ServiceAccountKeySchema } from './types.js';

export const MAX_CREDENTIAL_FILE_SIZE = 1024 * 1024; // 1 MiB
export const MAX_IMPORT_FILE_SIZE = 5 * 1024 * 1024; // 5 MiB

export const AdcDocumentSchema = z
  .object({
    type: z.string().min(1),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    refresh_token: z.string().optional(),
    quota_project_id: z.string().optional(),
  })
  .passthrough();
export type AdcDocument = z.infer<typeof AdcDocumentSchema>;

export class CredentialFiles {
  /**
   * Validate that the path exists, is a regular file (not symlink/dir/device),
   * is non-empty, and does not exceed the size limit.
   */
  public static validateRegularFile(
    filePath: string,
    maxSizeBytes = MAX_CREDENTIAL_FILE_SIZE
  ): void {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not permitted for credential files: ${filePath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${filePath}`);
    }

    if (stat.size === 0) {
      throw new Error(`File is empty: ${filePath}`);
    }

    if (stat.size > maxSizeBytes) {
      throw new Error(`File exceeds maximum size of ${maxSizeBytes} bytes: ${filePath}`);
    }
  }

  /**
   * Safely read and parse a JSON file with strict file-type and size checks.
   */
  public static loadJsonFile<T>(filePath: string, maxSizeBytes = MAX_CREDENTIAL_FILE_SIZE): T {
    this.validateRegularFile(filePath, maxSizeBytes);
    const resolved = path.resolve(filePath);
    const flags =
      fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    let fd: number | null = null;
    let raw: string;

    try {
      fd = fs.openSync(resolved, flags);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        throw new Error(`Path is not a regular file: ${filePath}`);
      }
      if (stat.size === 0) {
        throw new Error(`File is empty: ${filePath}`);
      }
      if (stat.size > maxSizeBytes) {
        throw new Error(`File exceeds maximum size of ${maxSizeBytes} bytes: ${filePath}`);
      }
      raw = fs.readFileSync(fd, 'utf-8');
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ELOOP') {
        throw new Error(`Symbolic links are not permitted for credential files: ${filePath}`);
      }
      throw err;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }

    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(
        `Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Load and validate a Google Service Account JSON key file.
   */
  public static loadServiceAccountKeyFile(filePath: string): ServiceAccountKey {
    const data = this.loadJsonFile<unknown>(filePath, MAX_CREDENTIAL_FILE_SIZE);
    const validation = validateServiceAccountKey(data);
    if (!validation.ok) {
      throw new Error(`Invalid service account key file ${filePath}: ${validation.reason}`);
    }

    return ServiceAccountKeySchema.parse(data);
  }

  /**
   * Load and validate an Application Default Credentials (ADC) JSON file.
   */
  public static loadAdcFile(filePath: string): AdcDocument {
    const data = this.loadJsonFile<unknown>(filePath, MAX_CREDENTIAL_FILE_SIZE);
    const parsed = AdcDocumentSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `Invalid application default credentials in ${filePath}: ${parsed.error.issues.map((i) => i.message).join(', ')}`
      );
    }

    if (parsed.data.type === 'external_account') {
      throw new Error(
        `Unsupported ADC credential type 'external_account' in ${filePath}: Workload Identity Federation is not supported in v0.1.`
      );
    }

    const supportedTypes = ['authorized_user', 'service_account'];
    if (!supportedTypes.includes(parsed.data.type)) {
      throw new Error(
        `Unsupported ADC credential type '${parsed.data.type}' in ${filePath}. Supported types: ${supportedTypes.join(', ')}`
      );
    }

    const validation = validateAdcDocument(parsed.data);
    if (!validation.ok) {
      throw new Error(
        `Invalid application default credentials in ${filePath}: ${validation.reason}`
      );
    }

    return parsed.data;
  }

  /**
   * Load and validate an export/backup JSON file (supporting both format v1 and v2).
   */
  public static loadExportBackupFile(filePath: string): ExportDocumentV2 {
    const data = this.loadJsonFile<unknown>(filePath, MAX_IMPORT_FILE_SIZE);
    return migrateExportDocument(data);
  }
}
