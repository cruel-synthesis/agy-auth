import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectInstallMethod,
  isNewer,
  updateCommand,
  upgradeCommandFor,
} from '../src/commands/update.js';
import { CliError } from '../src/core/errors.js';
import { VERSION } from '../src/version.js';

const BREW =
  '/opt/homebrew/Cellar/agy-auth/0.1.1/libexec/lib/node_modules/@cruel-synthesis/agy-auth/dist/cli-bin.js';
const NPM = '/opt/homebrew/lib/node_modules/@cruel-synthesis/agy-auth/dist/cli-bin.js';

function registry(version: string | undefined, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(version ? { version } : {}), { status })
  ) as unknown as typeof fetch;
}

function bump(v: string): string {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

describe('update', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells Homebrew, npm, npx and source installs apart', () => {
    expect(detectInstallMethod(BREW)).toBe('homebrew');
    expect(detectInstallMethod(NPM)).toBe('npm');
    expect(
      detectInstallMethod(
        'C:\\Users\\ava\\AppData\\Roaming\\npm\\node_modules\\@cruel-synthesis\\agy-auth\\dist\\cli-bin.js'
      )
    ).toBe('npm');
    expect(
      detectInstallMethod(
        '/home/ava/.npm/_npx/1a2b/node_modules/@cruel-synthesis/agy-auth/dist/x.js'
      )
    ).toBe('npx');
    expect(detectInstallMethod('/home/ava/src/agy-auth/dist/cli-bin.js')).toBe('unknown');
  });

  it('upgrades with the package manager that installed it', () => {
    expect(upgradeCommandFor('homebrew')).toEqual(['brew', ['upgrade', 'agy-auth']]);
    expect(upgradeCommandFor('npm')).toEqual([
      'npm',
      ['install', '--global', '@cruel-synthesis/agy-auth@latest'],
    ]);
    expect(upgradeCommandFor('npx')).toBeNull();
    expect(upgradeCommandFor('unknown')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1.1', '0.1.2')).toBe(false);
    expect(isNewer('0.2.0-beta.1', '0.1.9')).toBe(true);
  });

  it('runs nothing when already on the latest version', async () => {
    const run = vi.fn(() => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateCommand({}, { fetchFn: registry(VERSION), installPath: NPM, run });
    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('is the latest version');
  });

  it('runs the matching upgrade when a newer version exists', async () => {
    const run = vi.fn(() => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateCommand({}, { fetchFn: registry(bump(VERSION)), installPath: BREW, run });
    expect(run).toHaveBeenCalledWith('brew', ['upgrade', 'agy-auth']);
    expect(log.mock.calls.flat().join('\n')).toContain(`Updated agy-auth to ${bump(VERSION)}`);
  });

  it('only reports with --check', async () => {
    const run = vi.fn(() => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateCommand(
      { check: true },
      { fetchFn: registry(bump(VERSION)), installPath: NPM, run }
    );
    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('is available');
  });

  it('never installs with --json', async () => {
    const run = vi.fn(() => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateCommand(
      { json: true },
      { fetchFn: registry(bump(VERSION)), installPath: NPM, run }
    );
    expect(run).not.toHaveBeenCalled();
    const out = JSON.parse(log.mock.calls[0][0] as string);
    expect(out).toMatchObject({
      command: 'update',
      ok: true,
      data: {
        current: VERSION,
        latest: bump(VERSION),
        updateAvailable: true,
        installMethod: 'npm',
        command: 'npm install --global @cruel-synthesis/agy-auth@latest',
      },
    });
  });

  it('does not guess an upgrade for a copy it cannot place', async () => {
    const run = vi.fn(() => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateCommand(
      {},
      { fetchFn: registry(bump(VERSION)), installPath: '/home/ava/src/agy-auth/dist/x.js', run }
    );
    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('the way you installed it');
  });

  it('fails clearly when the package manager fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = await updateCommand(
      {},
      { fetchFn: registry(bump(VERSION)), installPath: NPM, run: () => 243 }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('update_failed');
  });

  it('fails clearly when the registry cannot be read', async () => {
    for (const fetchFn of [registry(undefined), registry('1.0.0', 503)]) {
      const err = await updateCommand({}, { fetchFn, installPath: NPM }).catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect(err.code).toBe('update_check_failed');
    }
  });

  it('refuses to start a package manager in an isolated environment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      updateCommand({}, { fetchFn: registry(bump(VERSION)), installPath: NPM })
    ).rejects.toThrow(/Blocked native operation/);
  });
});
