import fs from 'node:fs';
import path from 'node:path';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { escapePosix } from '../src/commands/env.js';
import { CredentialFiles } from '../src/core/credential-files.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { CorruptedRegistryError } from '../src/core/storage.js';
import { Account, AccountSchema, sanitizeAccount, sanitizeAccounts } from '../src/core/types.js';
import { truncateToWidth } from '../src/ui/table.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

describe('Security & Sanitization', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('neutralizes shell command injection in env export values', () => {
    const maliciousPayload = 'x"; touch /private/tmp/AGY_AUTH_WOULD_EXECUTE; #"';
    const escaped = escapePosix(maliciousPayload);

    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    expect(escaped).toBe(`'x"; touch /private/tmp/AGY_AUTH_WOULD_EXECUTE; #"\'`);
  });

  it('completely strips sensitive credentials in sanitizeAccount', () => {
    const accountWithSecrets: Account = {
      id: 'acc1',
      email: 'user@example.com',
      authType: 'api-key',
      createdAt: 1000,
      updatedAt: 1000,
      status: 'valid',
      credentials: {
        apiKey: 'fake-api-key-for-sanitization',
        serviceAccountKey: {
          type: 'service_account',
          project_id: 'p',
          client_email: 'sa@p.iam.gserviceaccount.com',
          private_key: 'fake-private-key-for-sanitization',
        },
      },
    };

    const sanitized = sanitizeAccount(accountWithSecrets);
    expect((sanitized as unknown as Record<string, unknown>).credentials).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain('fake-api-key-for-sanitization');
    expect(JSON.stringify(sanitized)).not.toContain('fake-private-key-for-sanitization');

    const multiSanitized = sanitizeAccounts([accountWithSecrets]);
    expect((multiSanitized[0] as unknown as Record<string, unknown>).credentials).toBeUndefined();
  });

  it('enforces strict Zod validation and rejects path traversal IDs', () => {
    const maliciousAccount = {
      id: '../../etc/passwd',
      email: 'test@example.com',
      authType: 'api-key',
      status: 'unverified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const parseResult = AccountSchema.safeParse(maliciousAccount);
    expect(parseResult.success).toBe(false);
  });

  it('rejects symbolic links for ADC files', () => {
    if (process.platform === 'win32') return;

    const target = path.join(testEnv.dir, 'adc.json');
    const link = path.join(testEnv.dir, 'adc-link.json');
    fs.writeFileSync(
      target,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'client',
        client_secret: 'placeholder-test-secret',
        refresh_token: 'refresh',
      })
    );
    fs.symlinkSync(target, link);

    expect(() => CredentialFiles.validateRegularFile(link)).toThrow(/symbolic link/i);
  });

  it('rejects sibling paths that share the test directory prefix', () => {
    const siblingPath = path.join(`${testEnv.dir}-outside`, 'registry.json');

    expect(() => testEnv.assertPathInsideTestDir(siblingPath)).toThrow(/Isolation breach/);
    expect(() =>
      testEnv.assertPathInsideTestDir(path.join(testEnv.dir, 'nested', 'registry.json'))
    ).not.toThrow();
  });

  it('truncates Unicode and CJK strings width-safely without visual overflow', () => {
    const testCases = [
      { text: 'hello world', targetWidth: 8, maxExpectedWidth: 8 },
      { text: '你好世界这是一个很长的名字', targetWidth: 10, maxExpectedWidth: 10 },
      { text: 'test@example.com', targetWidth: 12, maxExpectedWidth: 12 },
      { text: '✨🌟🎉🚀🔥', targetWidth: 6, maxExpectedWidth: 6 },
    ];

    for (const tc of testCases) {
      const truncated = truncateToWidth(tc.text, tc.targetWidth, '.');
      const measured = stringWidth(truncated);
      expect(measured).toBeLessThanOrEqual(tc.maxExpectedWidth);
    }
  });

  it('fails closed on corrupted registry and creates emergency backup', () => {
    const regFile = Paths.registryFile;
    fs.writeFileSync(regFile, '{ corrupt json !!!', 'utf-8');

    expect(() => new RegistryManager()).toThrow(CorruptedRegistryError);

    // Verify emergency backup exists
    const backups = fs.readdirSync(Paths.backupsDir);
    const hasEmergency = backups.some((b) => b.includes('corrupt_registry_emergency'));
    expect(hasEmergency).toBe(true);

    // Verify damaged file was not wiped
    expect(fs.readFileSync(regFile, 'utf-8')).toBe('{ corrupt json !!!');
  });
});
