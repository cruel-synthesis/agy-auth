import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../src/commands/add.js';
import { aliasClearCommand, aliasSetCommand } from '../src/commands/alias.js';
import { cleanCommand } from '../src/commands/clean.js';
import { currentCommand } from '../src/commands/current.js';
import { detailsCommand } from '../src/commands/details.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { envCommand } from '../src/commands/env.js';
import { exportCommand } from '../src/commands/export.js';
import { importCommand } from '../src/commands/import.js';
import { listCommand } from '../src/commands/list.js';
import { modelClearCommand, modelSetCommand } from '../src/commands/model.js';
import { projectClearCommand, projectSetCommand } from '../src/commands/project.js';
import { removeCommand } from '../src/commands/remove.js';
import { switchCommand } from '../src/commands/switch.js';
import {
  AccountNotFoundError,
  AmbiguousSelectorError,
  CancellationError,
  CliError,
  UsageError,
} from '../src/core/errors.js';
import { KeychainManager } from '../src/core/keychain.js';
import { Paths } from '../src/core/paths.js';
import { RegistryManager } from '../src/core/registry.js';
import { Storage } from '../src/core/storage.js';
import {
  TestEnv,
  generateSyntheticPrivateKey,
  installNativeStoreDouble,
  setupTestEnvironment,
} from './test-utils.js';

describe('Command Modules Behavioral & Regression Suite', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('executes addCommand with API key, Service Account, and ADC profiles', async () => {
    // 1. Add API key
    await addCommand({
      apiKey: 'AIzaSy1234567890',
      email: 'apikey@example.com',
      alias: 'gemini-key',
      project: 'my-proj',
      location: 'us-central1',
      model: 'gemini-2.5-pro',
      json: true,
    });

    const registry = new RegistryManager();
    const acc1 = registry.findAccount('gemini-key');
    expect(acc1).toBeTruthy();
    expect(acc1?.email).toBe('apikey@example.com');
    expect(acc1?.gcpProject).toBe('my-proj');

    // 2. Add Service Account
    const pem = generateSyntheticPrivateKey();
    const saFile = path.join(testEnv.dir, 'sa-test.json');
    fs.writeFileSync(
      saFile,
      JSON.stringify({
        type: 'service_account',
        project_id: 'sa-proj',
        client_email: 'sa@sa-proj.iam.gserviceaccount.com',
        private_key: pem,
        universe_domain: 'googleapis.com',
      })
    );

    await addCommand({
      serviceAccount: saFile,
      alias: 'sa-profile',
      json: false,
    });

    const acc2 = registry.findAccount('sa-profile');
    expect(acc2).toBeTruthy();
    expect(acc2?.email).toBe('sa@sa-proj.iam.gserviceaccount.com');
    expect(acc2?.credentials?.serviceAccountKey?.universe_domain).toBe('googleapis.com');

    // 3. Add ADC profile
    const adcFile = path.join(testEnv.dir, 'adc-test.json');
    fs.writeFileSync(
      adcFile,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'cs',
        refresh_token: 'tok',
      })
    );

    await addCommand({
      adc: adcFile,
      email: 'adc-user@example.com',
      alias: 'adc-profile',
    });

    const acc3 = registry.findAccount('adc-profile');
    expect(acc3).toBeTruthy();
    expect(acc3?.email).toBe('adc-user@example.com');

    // 4. API key with alias only
    await addCommand({
      apiKey: 'AIzaSyAliasOnly',
      alias: 'only-alias',
    });
    expect(new RegistryManager().findAccount('only-alias')?.email).toBe('only-alias@local.invalid');

    // 5. API key without email or alias throws UsageError
    await expect(
      addCommand({
        apiKey: 'AIzaSyNoEmailOrAlias',
      })
    ).rejects.toThrow(/Adding an API key requires --email/);

    // 6. Service Account with mismatched email throws UsageError
    await expect(
      addCommand({
        serviceAccount: saFile,
        email: 'mismatch@example.com',
      })
    ).rejects.toThrow(/does not match service account client_email/);

    // 7. ADC with alias only
    await addCommand({
      adc: adcFile,
      alias: 'adc-alias-only',
    });
    expect(new RegistryManager().findAccount('adc-alias-only')?.email).toBe(
      'adc-alias-only@local.invalid'
    );

    // 8. ADC with default path (adc: true)
    fs.writeFileSync(
      Paths.gcloudAdcFile,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'c',
        client_secret: 's',
        refresh_token: 'r',
      })
    );
    await addCommand({
      adc: true,
      email: 'adc-default@example.com',
      alias: 'adc-def-alias',
    });
    expect(new RegistryManager().findAccount('adc-def-alias')).toBeTruthy();

    // 9. ADC with invalid email throws UsageError
    await expect(
      addCommand({
        adc: true,
        email: 'invalid-email-format',
      })
    ).rejects.toThrow(/Invalid email address/);

    // 8. ADC without email or alias throws UsageError
    await expect(
      addCommand({
        adc: adcFile,
      })
    ).rejects.toThrow(/Adding ADC credentials requires --email/);

    // 9. Reject conflicting options
    await expect(
      addCommand({
        apiKey: 'key',
        serviceAccount: saFile,
      })
    ).rejects.toThrow(/at most one credential type/i);
  });

  it('executes listCommand in text and JSON modes with active and check filters', async () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'list-user@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });
    registry.setActiveAccount(acc.id);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    try {
      await listCommand({ json: true });
      await listCommand({ active: true, json: false });
      await listCommand({ check: true, json: false });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('executes switchCommand by alias, index, previous (-), and rejects ambiguous selectors', async () => {
    const registry = new RegistryManager();
    const acc1 = registry.addOrUpdateAccount({
      email: 'user1@example.com',
      alias: 'primary',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSy1' },
    });
    const acc2 = registry.addOrUpdateAccount({
      email: 'user2@example.com',
      alias: 'secondary',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSy2' },
    });

    // Switch by alias
    await switchCommand('primary', { json: true });
    expect(new RegistryManager().getActiveAccount()?.id).toBe(acc1.id);

    // Switch by 1-based number
    await switchCommand('2', { json: false });
    expect(new RegistryManager().getActiveAccount()?.id).toBe(acc2.id);

    // Switch to previous (-)
    await switchCommand('-', { json: true });
    expect(new RegistryManager().getActiveAccount()?.id).toBe(acc1.id);

    // Switch with ambiguous selector in JSON mode throws AmbiguousSelectorError
    await expect(switchCommand('user', { json: true })).rejects.toThrow(AmbiguousSelectorError);

    // Switch to previous (-) with no previous account throws UsageError
    const freshEnv = setupTestEnvironment();
    try {
      const emptyReg = new RegistryManager();
      emptyReg.addOrUpdateAccount({
        email: 'sole@example.com',
        authType: 'api-key',
        credentials: { apiKey: 'k' },
      });
      await expect(switchCommand('-', { json: false })).rejects.toThrow(
        /No previous account recorded/
      );

      // Switch when 0 accounts registered throws UsageError
      fs.rmSync(Paths.registryFile, { force: true });
      await expect(switchCommand('any')).rejects.toThrow(/No accounts yet/);
    } finally {
      freshEnv.cleanup();
    }

    // Empty selector with no TTY throws UsageError
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await expect(switchCommand(undefined)).rejects.toThrow(
        /Account selector required in non-interactive/
      );
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('keeps project and model out of current and available in details', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const output = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

    try {
      const registry = new RegistryManager();
      const acc = registry.addOrUpdateAccount({
        email: 'infra@example.com',
        authType: 'api-key',
        credentials: { apiKey: 'AIzaSyKey' },
        gcpProject: 'my-gcp',
        gcpLocation: 'us-central1',
        model: 'gemini-2.5-flash',
      });
      registry.setActiveAccount(acc.id);

      await currentCommand({ json: false, offline: true });
      const currentOutput = output();
      expect(currentOutput).toContain('infra@example.com');
      expect(currentOutput).toContain('Plan:');
      expect(currentOutput).not.toContain('my-gcp');
      expect(currentOutput).not.toContain('gemini-2.5-flash');
      expect(currentOutput).toContain('agy-auth details');

      logSpy.mockClear();
      await detailsCommand(acc.id, { json: false, offline: true });
      const detailsOutput = output();
      expect(detailsOutput).toContain('my-gcp');
      expect(detailsOutput).toContain('us-central1');
      expect(detailsOutput).toContain('gemini-2.5-flash');

      // The JSON contract is unchanged: every field stays addressable there.
      logSpy.mockClear();
      await currentCommand({ json: true, offline: true });
      const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
      expect(payload.data.account.gcpProject).toBe('my-gcp');
      expect(payload.data.account.model).toBe('gemini-2.5-flash');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('executes currentCommand and detailsCommand with formatted output and JSON', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // With no active account
      await currentCommand({ json: false });
      await currentCommand({ json: true });
      await detailsCommand(undefined, { json: false });
      await detailsCommand(undefined, { json: true });

      const registry = new RegistryManager();
      const acc = registry.addOrUpdateAccount({
        email: 'info@example.com',
        alias: 'my-info',
        authType: 'api-key',
        credentials: { apiKey: 'AIzaSyKey' },
        gcpProject: 'my-gcp',
        gcpLocation: 'us-central1',
        model: 'gemini-2.5-flash',
        reasoningEffort: 'low',
      });
      registry.setActiveAccount(acc.id);
      registry.syncMutate((draft) => {
        const stored = draft.accounts.find((account) => account.id === acc.id);
        if (!stored) throw new Error('test fixture account missing');
        stored.verification = {
          checkedAt: Date.now(),
          source: 'local',
          message: 'OK',
        };
        stored.status = 'valid';
        stored.updatedAt = Math.max(Date.now(), stored.updatedAt + 1);
      });

      await currentCommand({ json: true });
      await currentCommand({ json: false });

      // Plain account with no GCP or model
      const plainAcc = registry.addOrUpdateAccount({
        email: 'plain@example.com',
        authType: 'api-key',
        credentials: { apiKey: 'AIzaSyKey' },
      });
      registry.setActiveAccount(plainAcc.id);
      await currentCommand({ json: false });

      registry.setActiveAccount(acc.id);
      await detailsCommand('my-info', { json: true });
      await detailsCommand('my-info', { json: false });
      await detailsCommand(acc.id, { json: false });

      // Non-interactive details with no query defaults to active account
      const origTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;
      try {
        await detailsCommand(undefined, { json: false });
      } finally {
        process.stdout.isTTY = origTTY;
      }

      // Ambiguous selector
      registry.addOrUpdateAccount({
        email: 'info-2@example.com',
        alias: 'my-info-2',
        authType: 'api-key',
        credentials: { apiKey: 'AIzaSy2' },
      });
      await expect(detailsCommand('non-existent-query')).rejects.toThrow(AccountNotFoundError);

      // When accounts exist but none is active, details without query throws UsageError
      registry.syncMutate((draft) => {
        draft.activeAccountId = null;
      });
      await expect(detailsCommand(undefined, { json: true })).rejects.toThrow(
        /No account is selected/
      );
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('executes envCommand in posix and powershell modes with and without active account', async () => {
    const registry = new RegistryManager();
    const pem = generateSyntheticPrivateKey();
    const saAcc = registry.addOrUpdateAccount({
      email: 'sa-env@example.com',
      authType: 'service-account',
      gcpProject: 'env-gcp',
      gcpLocation: 'us-central1',
      credentials: {
        serviceAccountKey: {
          type: 'service_account',
          client_email: 'sa-env@example.com',
          project_id: 'env-gcp',
          private_key: pem,
        },
      },
    });
    registry.setActiveAccount(saAcc.id);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await envCommand({ shell: 'posix', json: false });
      await envCommand({ shell: 'powershell', json: false });
      await envCommand({ shell: 'bash', json: false });
      await envCommand({ shell: 'zsh', json: false });
      await envCommand({ clear: true, json: false });
      await envCommand({ clear: true, json: true });

      // Unsupported shell
      await expect(envCommand({ shell: 'fish' })).rejects.toThrow(/Unsupported shell format/);

      // env without active account throws UsageError
      registry.syncMutate((draft) => {
        draft.activeAccountId = null;
      });
      await expect(envCommand({ clear: false })).rejects.toThrow(/No active account configured/);

      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('executes removeCommand with multiple targets, --all, and handles service account cleanup failures', async () => {
    const registry = new RegistryManager();
    const pem = generateSyntheticPrivateKey();
    const acc1 = registry.addOrUpdateAccount({
      email: 'sa-rem1@example.com',
      alias: 'sa-rem1',
      authType: 'service-account',
      credentials: {
        serviceAccountKey: {
          type: 'service_account',
          client_email: 'sa-rem1@example.com',
          project_id: 'p',
          private_key: pem,
        },
      },
    });
    const acc2 = registry.addOrUpdateAccount({
      email: 'user2@example.com',
      alias: 'api-rem2',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });
    const acc3 = registry.addOrUpdateAccount({
      email: 'user3@example.com',
      alias: 'api-rem3',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });

    // Remove single profile in human mode
    await removeCommand(['api-rem2'], { yes: true, json: false });
    expect(new RegistryManager().findAccount('api-rem2')).toBeNull();

    // Remove single profile in JSON mode
    await removeCommand(['api-rem3'], { yes: true, json: true });
    expect(new RegistryManager().findAccount('api-rem3')).toBeNull();

    // Materialize SA file
    const saFile = path.join(Paths.accountsDir, `${acc1.id}.json`);
    fs.writeFileSync(saFile, 'fake-sa-file');

    // Simulate unlink failure only for sa json file
    const originalUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath: fs.PathLike) => {
      if (
        typeof filePath === 'string' &&
        filePath.endsWith('.json') &&
        filePath.includes(acc1.id)
      ) {
        throw new Error('Permission denied unlinking file');
      }
      return originalUnlink(filePath);
    });

    try {
      await expect(removeCommand(['sa-rem1'], { yes: true, json: true })).rejects.toThrow(
        /Account metadata was removed, but one or more credential key files could not be deleted/
      );
    } finally {
      unlinkSpy.mockRestore();
    }

    // Remove all remaining
    await removeCommand([], { all: true, yes: true, json: false });
    expect(new RegistryManager().getAccounts().length).toBe(0);

    // Remove when empty in json and human
    await removeCommand([], { json: true });
    await removeCommand([], { json: false });
  });

  it('executes alias, project, and model set and clear commands and validates errors', async () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'config@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // Alias
      await aliasSetCommand(acc.id, 'new-alias', { json: true });
      await aliasSetCommand(acc.id, 'new-alias-2', { json: false });
      expect(new RegistryManager().findAccount('new-alias-2')).toBeTruthy();
      await expect(aliasSetCommand('nonexistent', 'a')).rejects.toThrow(AccountNotFoundError);
      await expect(aliasSetCommand(acc.id, 'bad alias spaces')).rejects.toThrow(UsageError);

      const accDup = registry.addOrUpdateAccount({
        email: 'dup@example.com',
        authType: 'api-key',
        credentials: { apiKey: 'AIzaSyKey' },
      });
      await expect(aliasSetCommand(accDup.id, 'new-alias-2')).rejects.toThrow(/already in use/);

      await aliasClearCommand('new-alias-2', { json: true });
      await aliasSetCommand(acc.id, 'temp-alias', { json: false });
      await aliasClearCommand('temp-alias', { json: false });
      expect(new RegistryManager().findAccount(acc.id)?.alias).toBeUndefined();
      await expect(aliasClearCommand('nonexistent')).rejects.toThrow(AccountNotFoundError);

      // Project
      await projectSetCommand(acc.id, 'gcp-project-123', 'us-east1', { json: true });
      await projectSetCommand(acc.id, 'gcp-project-456', 'us-central1', { json: false });
      expect(new RegistryManager().findAccount(acc.id)?.gcpProject).toBe('gcp-project-456');
      await expect(projectSetCommand('nonexistent', 'p')).rejects.toThrow(AccountNotFoundError);
      await expect(projectSetCommand(acc.id, '   ')).rejects.toThrow(UsageError);
      await projectClearCommand(acc.id, { json: false });
      expect(new RegistryManager().findAccount(acc.id)?.gcpProject).toBeUndefined();
      await projectSetCommand(acc.id, 'gcp-project-789', undefined, { json: false });
      await projectClearCommand(acc.id, { json: true });
      await expect(projectClearCommand('nonexistent')).rejects.toThrow(AccountNotFoundError);

      // Model
      await modelSetCommand(acc.id, 'gemini-2.5-pro', { json: true });
      await modelSetCommand(acc.id, 'gemini-2.5-flash', { json: false });
      expect(new RegistryManager().findAccount(acc.id)?.model).toBe('gemini-2.5-flash');
      await expect(modelSetCommand('nonexistent', 'm')).rejects.toThrow(AccountNotFoundError);
      await expect(modelSetCommand(acc.id, '   ')).rejects.toThrow(UsageError);
      await modelClearCommand(acc.id, { json: false });
      expect(new RegistryManager().findAccount(acc.id)?.model).toBeUndefined();
      await modelSetCommand(acc.id, 'gemini-2.5-pro', { json: true });
      await modelClearCommand(acc.id, { json: true });
      await expect(modelClearCommand('nonexistent')).rejects.toThrow(AccountNotFoundError);

      // Ambiguous selector checks for alias, project, model
      registry.addOrUpdateAccount({
        email: 'config-2@example.com',
        authType: 'api-key',
        credentials: { apiKey: 'AIzaSyKey2' },
      });
      await expect(aliasSetCommand('config', 'a2')).rejects.toThrow(AmbiguousSelectorError);
      await expect(aliasClearCommand('config')).rejects.toThrow(AmbiguousSelectorError);
      await expect(projectSetCommand('config', 'p2')).rejects.toThrow(AmbiguousSelectorError);
      await expect(projectClearCommand('config')).rejects.toThrow(AmbiguousSelectorError);
      await expect(modelSetCommand('config', 'm2')).rejects.toThrow(AmbiguousSelectorError);
      await expect(modelClearCommand('config')).rejects.toThrow(AmbiguousSelectorError);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('executes doctorCommand in read-only mode and reports fail with exit code 1', async () => {
    const nativeStore = installNativeStoreDouble({ supported: false });
    // 1. Doctor on empty environment (should pass without creating files)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await doctorCommand({ offline: true, json: true });
      await doctorCommand({ offline: true, json: false });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }

    // 2. Doctor on corrupted registry should throw CliError with code doctor_failed
    fs.writeFileSync(Paths.registryFile, 'not-valid-json');
    await expect(doctorCommand({ offline: true, json: true })).rejects.toThrow(
      /One or more diagnostics checks failed/
    );
    nativeStore.restore();
  });

  it('executes cleanCommand with --dry-run, --all, and prunes backups', async () => {
    const sourceFile = path.join(testEnv.dir, 'source.json');
    fs.writeFileSync(sourceFile, '{}');

    for (let i = 0; i < 15; i++) {
      Storage.createBackup(sourceFile, `backup_${i}`);
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cleanCommand({ dryRun: true, json: true });
      await cleanCommand({ dryRun: true, json: false });
      await cleanCommand({ dryRun: false, json: false });
      await cleanCommand({ all: true, json: true });
      await cleanCommand({ all: true, json: false });
      expect(logSpy).toHaveBeenCalled();

      // Clean when backups dir is missing
      fs.rmSync(Paths.backupsDir, { recursive: true, force: true });
      await cleanCommand({ json: false });
      await cleanCommand({ json: true });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keeps the same backups on clean as automatic rotation does', async () => {
    // Identical timestamps leave only the tiebreak to decide, which is where two
    // separate retention loops could disagree.
    fs.mkdirSync(Paths.backupsDir, { recursive: true });
    const at = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 12; i++) {
      const name = `switch_token_2026-01-01T00-00-00-000Z_${i.toString(16).padStart(8, '0')}`;
      const file = path.join(Paths.backupsDir, name);
      fs.writeFileSync(file, '{}');
      fs.utimesSync(file, at, at);
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cleanCommand({ dryRun: true, json: true });
      const keptByClean = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data.keptFiles;

      Storage.rotateBackups(Paths.backupsDir);
      const keptByRotation = fs.readdirSync(Paths.backupsDir);

      expect(keptByClean).toHaveLength(10);
      expect([...keptByClean].sort()).toEqual([...keptByRotation].sort());
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports managed backup deletion failures instead of claiming success', async () => {
    const sourceFile = path.join(testEnv.dir, 'source.json');
    fs.writeFileSync(sourceFile, '{}');
    const backupPath = Storage.createBackup(sourceFile, 'backup');
    expect(backupPath).toBeTruthy();

    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === backupPath) throw new Error('synthetic delete failure');
      return undefined;
    });
    try {
      await expect(cleanCommand({ all: true })).rejects.toMatchObject({
        code: 'clean_failed',
        details: { failedFiles: [path.basename(backupPath as string)] },
      });
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('rejects a symlinked managed backup directory', async () => {
    if (process.platform === 'win32') return;

    const outside = path.join(testEnv.dir, 'outside-backups');
    fs.mkdirSync(outside);
    fs.rmSync(Paths.backupsDir, { recursive: true });
    fs.symlinkSync(outside, Paths.backupsDir);

    await expect(cleanCommand({ all: true })).rejects.toMatchObject({ code: 'clean_failed' });
  });

  it('refuses an import that would duplicate an alias before backing anything up', async () => {
    const registry = new RegistryManager();
    registry.addOrUpdateAccount({
      email: 'held@example.com',
      alias: 'work',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyHeldKey' },
    });
    const exported = path.join(testEnv.dir, 'alias-export.json');
    await exportCommand({ output: exported, includeSecrets: true, yes: true, json: true });
    const doc = JSON.parse(fs.readFileSync(exported, 'utf-8'));
    doc.accounts[0] = {
      ...doc.accounts[0],
      id: 'acc_other',
      email: 'other@example.com',
      alias: 'WORK',
    };
    fs.writeFileSync(exported, JSON.stringify(doc));

    await expect(importCommand(exported, {})).rejects.toThrow(UsageError);
    await expect(importCommand(exported, {})).rejects.toThrow(/alias 'WORK'/);
    const backups = fs.existsSync(Paths.backupsDir) ? fs.readdirSync(Paths.backupsDir) : [];
    expect(backups.filter((name) => name.startsWith('import_'))).toEqual([]);
  });

  it('executes exportCommand and importCommand with strict validation and non-overwrite rules', async () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'exp-user@example.com',
      alias: 'exp-alias',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSySecretApiKey' },
    });

    const exportPathSanitized = path.join(testEnv.dir, 'sanitized-export.json');
    const exportPathSecret = path.join(testEnv.dir, 'secret-export.json');

    // Export sanitized (default)
    await exportCommand({ output: exportPathSanitized, yes: true, json: true });
    const sanitizedDoc = JSON.parse(fs.readFileSync(exportPathSanitized, 'utf-8'));
    expect(sanitizedDoc.includesSecrets).toBe(false);
    expect(sanitizedDoc.accounts[0].credentials).toBeUndefined();

    // Export with secrets without --yes in JSON mode throws UsageError
    await expect(
      exportCommand({ output: exportPathSecret, includeSecrets: true, yes: false, json: true })
    ).rejects.toThrow(/Exporting secrets in non-interactive/);

    // Export with secrets
    await exportCommand({ output: exportPathSecret, includeSecrets: true, yes: true, json: false });
    const secretDoc = JSON.parse(fs.readFileSync(exportPathSecret, 'utf-8'));
    expect(secretDoc.includesSecrets).toBe(true);
    expect(secretDoc.accounts[0].credentials.apiKey).toBe('AIzaSySecretApiKey');

    // Export to directory path
    const exportDir = path.join(testEnv.dir, 'export-dir');
    fs.mkdirSync(exportDir, { recursive: true });
    await exportCommand({ output: exportDir, yes: true });

    // Prevent overwriting existing file
    await expect(exportCommand({ output: exportPathSanitized, yes: true })).rejects.toThrow(
      /already exists/
    );

    // Import secret-free into clean registry without credentials should be rejected
    const freshEnv = setupTestEnvironment();
    try {
      await expect(importCommand(exportPathSanitized, { overwrite: false })).rejects.toThrow(
        /Cannot import new account .* without credentials/
      );
    } finally {
      freshEnv.cleanup();
    }

    // Import with overwrite onto existing account preserves credentials
    await importCommand(exportPathSanitized, { overwrite: true, json: true });
    await importCommand(exportPathSanitized, { overwrite: true, json: false });
    const updated = new RegistryManager().findAccount(acc.id);
    expect(updated?.credentials?.apiKey).toBe('AIzaSySecretApiKey');

    // Import new account with credentials
    const pem = generateSyntheticPrivateKey();
    const newAccDoc = {
      kind: 'agy-auth-export',
      formatVersion: 2,
      registrySchemaVersion: 2,
      exportedAt: new Date().toISOString(),
      includesSecrets: true,
      accounts: [
        {
          id: 'acc_imported_sa',
          email: 'imported-sa@example.com',
          authType: 'service-account',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          credentials: {
            serviceAccountKey: {
              type: 'service_account',
              project_id: 'imp-proj',
              client_email: 'imported-sa@example.com',
              private_key: pem,
            },
          },
        },
      ],
    };
    const newAccFile = path.join(testEnv.dir, 'import-sa.json');
    fs.writeFileSync(newAccFile, JSON.stringify(newAccDoc));
    // Import new account with credentials adds account
    await importCommand(newAccFile, { overwrite: false, json: true });
    expect(new RegistryManager().findAccount('imported-sa@example.com')).toBeTruthy();

    // Non-overwrite import with existing account skips
    await importCommand(exportPathSecret, { overwrite: false, json: true });

    // ID collision import error
    const collisionDoc = {
      kind: 'agy-auth-export',
      formatVersion: 2,
      registrySchemaVersion: 2,
      exportedAt: new Date().toISOString(),
      includesSecrets: true,
      accounts: [
        {
          id: acc.id,
          email: 'different-email@example.com',
          authType: 'api-key',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          credentials: { apiKey: 'AIzaSyKey' },
        },
      ],
    };
    const collisionFile = path.join(testEnv.dir, 'collision.json');
    fs.writeFileSync(collisionFile, JSON.stringify(collisionDoc));
    await expect(importCommand(collisionFile)).rejects.toThrow(/ID collision for/);

    // Import conflict error (matches ID of one account and identity of another)
    const otherAcc = registry.addOrUpdateAccount({
      email: 'other@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'AIzaSyKey' },
    });
    const conflictDoc = {
      kind: 'agy-auth-export',
      formatVersion: 2,
      registrySchemaVersion: 2,
      exportedAt: new Date().toISOString(),
      includesSecrets: true,
      accounts: [
        {
          id: acc.id,
          email: otherAcc.email,
          authType: 'api-key',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          credentials: { apiKey: 'AIzaSyKey' },
        },
      ],
    };
    const conflictFile = path.join(testEnv.dir, 'conflict.json');
    fs.writeFileSync(conflictFile, JSON.stringify(conflictDoc));
    await expect(importCommand(conflictFile)).rejects.toThrow(/Import conflict/);

    // Overwrite with invalid credentials
    const invalidCredsDoc = {
      kind: 'agy-auth-export',
      formatVersion: 2,
      registrySchemaVersion: 2,
      exportedAt: new Date().toISOString(),
      includesSecrets: true,
      accounts: [
        {
          id: acc.id,
          email: acc.email,
          authType: 'api-key',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          credentials: { apiKey: '' },
        },
      ],
    };
    const invalidCredsFile = path.join(testEnv.dir, 'invalid-creds.json');
    fs.writeFileSync(invalidCredsFile, JSON.stringify(invalidCredsDoc));
    await expect(importCommand(invalidCredsFile, { overwrite: true })).rejects.toThrow(
      /Invalid credentials for account/
    );
  });

  it('adds the Antigravity account, and updates it rather than duplicating on a repeat', async () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const readSpy = vi.spyOn(KeychainManager, 'readAgyTokenState').mockReturnValue({
      status: 'found',
      payload: {
        auth_method: 'consumer',
        token: { access_token: 'ya29.sync-token', refresh_token: '1//sync-refresh' },
      },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await addCommand({ email: 'synced@example.com', json: true });
      const acc = new RegistryManager().findAccount('synced@example.com');
      expect(acc).toBeTruthy();
      expect(acc?.authType).toBe('oauth');

      await addCommand({ email: 'synced@example.com', json: false });
      expect(new RegistryManager().getAccounts().length).toBe(1);

      await expect(addCommand({ email: 'bad-email' })).rejects.toThrow(
        /Invalid OAuth email address/
      );

      // No session to read means there is nothing to add, and saying so beats
      // reporting a successful run that added nothing.
      readSpy.mockReturnValue({ status: 'missing' });
      await expect(addCommand({ yes: true })).rejects.toMatchObject({ code: 'no_session' });

      expect(logSpy).toHaveBeenCalled();
    } finally {
      isSupportedSpy.mockRestore();
      readSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
