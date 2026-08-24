import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistryManager } from '../src/core/registry.js';
import { VERSION } from '../src/version.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

describe('Built CLI Integration and Concurrency', () => {
  let testEnv: TestEnv;
  const cliPath = path.resolve('bin/agy-auth.js');

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  function runCli(
    args: string[],
    envOverrides: Record<string, string> = {}
  ): {
    stdout: string;
    stderr: string;
    status: number;
  } {
    try {
      const stdout = execFileSync('node', [cliPath, ...args], {
        encoding: 'utf-8',
        env: {
          ...testEnv.createSubprocessEnv(),
          NO_COLOR: '1',
          ...envOverrides,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
      return {
        stdout: e.stdout?.toString() || '',
        stderr: e.stderr?.toString() || '',
        status: e.status ?? 1,
      };
    }
  }

  it('reports the correct version and help', () => {
    const res = runCli(['--version']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(VERSION);

    const helpRes = runCli(['--help']);
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain('agy-auth');
  });

  it('outputs versioned JSON envelopes and redacts secrets', () => {
    // 1. Add profile with secret
    const addRes = runCli([
      'add',
      '--email',
      'secret-bot@example.com',
      '--api-key',
      'super-secret-api-key',
      '--project',
      'test-proj',
      '--json',
    ]);
    expect(addRes.status).toBe(0);
    const addJson = JSON.parse(addRes.stdout);
    expect(addJson.schemaVersion).toBe(1);
    expect(addJson.command).toBe('add');
    expect(addJson.ok).toBe(true);
    expect(addJson.data.account.email).toBe('secret-bot@example.com');
    expect(addJson.data.account.credentials).toBeUndefined(); // Secret redacted!

    // 2. List in JSON
    const listRes = runCli(['list', '--json']);
    expect(listRes.status).toBe(0);
    const listJson = JSON.parse(listRes.stdout);
    expect(listJson.schemaVersion).toBe(1);
    expect(listJson.command).toBe('list');
    expect(listJson.ok).toBe(true);
    expect(listJson.data.total).toBe(1);
    expect(listJson.data.accounts[0].credentials).toBeUndefined(); // Secret redacted!

    // 3. Switch in JSON
    const switchRes = runCli(['switch', 'secret-bot@example.com', '--json']);
    expect(switchRes.status).toBe(0);
    const switchJson = JSON.parse(switchRes.stdout);
    expect(switchJson.schemaVersion).toBe(1);
    expect(switchJson.command).toBe('switch');
    expect(switchJson.ok).toBe(true);
    expect(switchJson.data.currentAccount.credentials).toBeUndefined(); // Secret redacted!
  });

  it('outputs structured JSON error on invalid usage and keeps stderr silent in JSON mode', () => {
    // Invalid usage on empty registry (exit code 2)
    const emptyUsageRes = runCli(['switch', 'some-user@example.com', '--json']);
    expect(emptyUsageRes.status).toBe(2);
    expect(emptyUsageRes.stderr).toBe('');
    const emptyJson = JSON.parse(emptyUsageRes.stdout);
    expect(emptyJson.schemaVersion).toBe(1);
    expect(emptyJson.ok).toBe(false);
    expect(emptyJson.error.code).toBe('invalid_usage');

    // Add a profile first
    runCli(['add', '--email', 'existing@example.com', '--api-key', 'key123', '--json']);

    // Account not found when accounts exist (exit code 1)
    const notFoundRes = runCli(['switch', 'non-existent-user@example.com', '--json']);
    expect(notFoundRes.status).toBe(1);
    expect(notFoundRes.stderr).toBe('');
    const notFoundJson = JSON.parse(notFoundRes.stdout);
    expect(notFoundJson.schemaVersion).toBe(1);
    expect(notFoundJson.command).toBe('switch');
    expect(notFoundJson.ok).toBe(false);
    expect(notFoundJson.error.code).toBe('account_not_found');
    expect(notFoundJson.error.message).toContain('non-existent-user');

    // Precondition failure on switch surfaces invalid_profile_credentials code and exit 1
    const adcFilePath = path.join(testEnv.dir, 'temp-adc.json');
    fs.writeFileSync(
      adcFilePath,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'csec',
        refresh_token: 'tok',
      })
    );
    runCli(['add', '--email', 'adc-precond@example.com', '--adc', adcFilePath, '--json']);
    fs.unlinkSync(adcFilePath); // Delete file so switch fails preflight

    const brokenRes = runCli(['switch', 'adc-precond@example.com', '--json']);
    expect(brokenRes.status).toBe(1);
    expect(brokenRes.stderr).toBe('');
    const brokenJson = JSON.parse(brokenRes.stdout);
    expect(brokenJson.schemaVersion).toBe(1);
    expect(brokenJson.command).toBe('switch');
    expect(brokenJson.ok).toBe(false);
    expect(brokenJson.error.code).toBe('invalid_profile_credentials');
    expect(brokenJson.error.message).toContain('Invalid ADC credentials');
  });

  it('handles 40 concurrent CLI process mutations without registry corruption', async () => {
    const processCount = 40;
    const subEnv = {
      ...testEnv.createSubprocessEnv(),
      NO_COLOR: '1',
    };

    const spawnPromises: Promise<number>[] = [];

    for (let i = 0; i < processCount; i++) {
      const email = `concurrent-user-${i}@example.com`;
      const p = new Promise<number>((resolve) => {
        const child = spawn(
          'node',
          [cliPath, 'add', '--email', email, '--api-key', `key-${i}`, '--json'],
          {
            env: subEnv,
            stdio: 'ignore',
          }
        );
        child.on('close', (code) => resolve(code ?? 1));
      });
      spawnPromises.push(p);
    }

    const exitCodes = await Promise.all(spawnPromises);
    for (const code of exitCodes) {
      expect(code).toBe(0);
    }

    // Verify all 40 accounts are present in registry
    const listRes = runCli(['list', '--json']);
    expect(listRes.status).toBe(0);
    const listData = JSON.parse(listRes.stdout);
    expect(listData.ok).toBe(true);
    expect(listData.data.total).toBe(processCount);
  });
});
