import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  envCommand,
  escapePosix,
  escapePowerShell,
  generateEnvStatements,
} from '../src/commands/env.js';
import { RegistryManager } from '../src/core/registry.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

describe('Shell Environment Generation and Escaping', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('escapes single quotes and special characters for POSIX shell', () => {
    expect(escapePosix('simple')).toBe("'simple'");
    expect(escapePosix("don't fail; rm -rf /")).toBe("'don'\\''t fail; rm -rf /'");
    expect(escapePosix('$(whoami)`cat /etc/passwd`"')).toBe("'$(whoami)`cat /etc/passwd`\"'");
  });

  it('escapes single quotes for PowerShell', () => {
    expect(escapePowerShell('simple')).toBe("'simple'");
    expect(escapePowerShell("don't fail")).toBe("'don''t fail'");
    expect(escapePowerShell('$env:PATH; "evil"')).toBe('\'$env:PATH; "evil"\'');
    // PowerShell treats these as single quotes too; any of them would end the string.
    expect(escapePowerShell('a\u2019; calc; \u2018b \u201A\u201B')).toBe(
      "'a\u2019\u2019; calc; \u2018\u2018b \u201A\u201A\u201B\u201B'"
    );
  });

  it('generates POSIX export and unset statements', () => {
    const stmts = generateEnvStatements(
      {
        GOOGLE_CLOUD_PROJECT: 'my-project',
        GEMINI_API_KEY: null,
      },
      'posix'
    );

    expect(stmts).toEqual(["export GOOGLE_CLOUD_PROJECT='my-project'", 'unset GEMINI_API_KEY']);
  });

  it('generates PowerShell environment statements', () => {
    const stmts = generateEnvStatements(
      {
        GOOGLE_CLOUD_PROJECT: 'my-project',
        GEMINI_API_KEY: null,
      },
      'powershell'
    );

    expect(stmts).toEqual([
      "$env:GOOGLE_CLOUD_PROJECT = 'my-project'",
      'Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue',
    ]);
  });

  it('emits complete 5-variable state for active API key profile and unsets inactive variables', async () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'api@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'secret-key-123' },
      gcpProject: 'proj-1',
    });
    registry.setActiveAccount(acc.id);

    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => {
      stdout += `${msg}\n`;
    };

    try {
      await envCommand({ shell: 'posix' });
      expect(stdout).toContain("export GEMINI_API_KEY='secret-key-123'");
      expect(stdout).toContain("export GOOGLE_API_KEY='secret-key-123'");
      expect(stdout).toContain("export GOOGLE_CLOUD_PROJECT='proj-1'");
      expect(stdout).toContain('unset GOOGLE_APPLICATION_CREDENTIALS');
      expect(stdout).toContain('unset GOOGLE_CLOUD_LOCATION');
    } finally {
      console.log = origLog;
    }
  });

  it('unsets all 5 variables with env --clear even without active profile', async () => {
    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => {
      stdout += `${msg}\n`;
    };

    try {
      await envCommand({ clear: true, shell: 'posix' });
      expect(stdout).toContain('unset GEMINI_API_KEY');
      expect(stdout).toContain('unset GOOGLE_API_KEY');
      expect(stdout).toContain('unset GOOGLE_APPLICATION_CREDENTIALS');
      expect(stdout).toContain('unset GOOGLE_CLOUD_PROJECT');
      expect(stdout).toContain('unset GOOGLE_CLOUD_LOCATION');
    } finally {
      console.log = origLog;
    }
  });

  it('outputs containsSecrets: true in env --json', async () => {
    const registry = new RegistryManager();
    const acc = registry.addOrUpdateAccount({
      email: 'api@example.com',
      authType: 'api-key',
      credentials: { apiKey: 'secret-key-123' },
    });
    registry.setActiveAccount(acc.id);

    let jsonOutput = '';
    const origLog = console.log;
    console.log = (msg: string) => {
      jsonOutput += `${msg}\n`;
    };

    try {
      await envCommand({ json: true });
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.command).toBe('env');
      expect(parsed.ok).toBe(true);
      expect(parsed.data.containsSecrets).toBe(true);
      expect(parsed.data.variables.GEMINI_API_KEY).toBe('secret-key-123');
    } finally {
      console.log = origLog;
    }
  });
});
