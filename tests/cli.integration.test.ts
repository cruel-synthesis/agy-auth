import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { guardedNodeArgs, TestEnv, setupTestEnvironment } from './test-utils.js';

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
      const stdout = execFileSync('node', guardedNodeArgs(cliPath, ...args), {
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

  it('blocks network and native access in processes the suite spawns', () => {
    const probePath = path.join(testEnv.dir, 'transport-probe.mjs');
    fs.writeFileSync(
      probePath,
      [
        'try {',
        "  await fetch('https://127.0.0.1:1/');",
        "  console.log('REACHED_NETWORK');",
        '} catch (err) {',
        "  console.log('FETCH_ERROR:' + err.message);",
        '}',
        "console.log('NO_NATIVE:' + process.env.AGY_AUTH_NO_NATIVE);",
      ].join('\n')
    );

    const stdout = execFileSync('node', guardedNodeArgs(probePath), {
      encoding: 'utf-8',
      env: testEnv.createSubprocessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(stdout).not.toContain('REACHED_NETWORK');
    expect(stdout).toContain('FETCH_ERROR:Tests must not perform real network requests');
    expect(stdout).toContain('NO_NATIVE:1');
  });

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
    // An option the command does not take is a usage error (exit code 2)
    const badFlagsRes = runCli(['list', '--offline', '--json']);
    expect(badFlagsRes.status).toBe(2);
    expect(badFlagsRes.stderr).toBe('');
    const badFlagsJson = JSON.parse(badFlagsRes.stdout);
    expect(badFlagsJson.schemaVersion).toBe(1);
    expect(badFlagsJson.ok).toBe(false);
    expect(badFlagsJson.error.code).toBe('invalid_usage');

    // An empty registry is a state the command found, not a bad invocation.
    const emptyRes = runCli(['switch', 'some-user@example.com', '--json']);
    expect(emptyRes.status).toBe(1);
    expect(emptyRes.stderr).toBe('');
    const emptyJson = JSON.parse(emptyRes.stdout);
    expect(emptyJson.schemaVersion).toBe(1);
    expect(emptyJson.ok).toBe(false);
    expect(emptyJson.error.code).toBe('no_accounts');

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

    // Keep what a failing process reported. A bare exit code cannot distinguish
    // a lock timeout from a corrupted write, and this contention only shows up
    // on machines slow enough to serialize 40 processes near the lock timeout.
    // `--json` puts the error on stdout, so both streams are kept.
    const spawnPromises: Promise<{ code: number; output: string }>[] = [];

    for (let i = 0; i < processCount; i++) {
      const email = `concurrent-user-${i}@example.com`;
      const p = new Promise<{ code: number; output: string }>((resolve) => {
        const child = spawn(
          'node',
          guardedNodeArgs(cliPath, 'add', '--email', email, '--api-key', `key-${i}`, '--json'),
          {
            env: subEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          output += chunk;
        });
        // A spawn that never starts emits 'error', not 'close'. Unhandled, it
        // takes down the runner instead of being reported with the other 39.
        child.on('error', (err) => resolve({ code: 1, output: `${output}${err}` }));
        child.on('close', (code) => resolve({ code: code ?? 1, output }));
      });
      spawnPromises.push(p);
    }

    const results = await Promise.all(spawnPromises);
    const failures = results.filter((r) => r.code !== 0);
    expect(
      failures.map((f) => `exit ${f.code}: ${f.output.trim() || '(no output)'}`).join('\n')
    ).toBe('');

    // Verify all 40 accounts are present in registry
    const listRes = runCli(['list', '--json']);
    expect(listRes.status).toBe(0);
    const listData = JSON.parse(listRes.stdout);
    expect(listData.ok).toBe(true);
    expect(listData.data.total).toBe(processCount);
  });
});
