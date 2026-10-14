import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CliError } from '../core/errors.js';
import { assertNativeAllowed } from '../core/native-guard.js';
import { printJsonResult } from '../ui/format.js';
import { colors, marks } from '../ui/theme.js';
import { VERSION } from '../version.js';

const PACKAGE_NAME = '@cruel-synthesis/agy-auth';
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export type InstallMethod = 'homebrew' | 'npm' | 'npx' | 'unknown';

interface UpdateOptions {
  check?: boolean;
  json?: boolean;
}

interface UpdateServices {
  fetchFn?: typeof fetch;
  /** Where this copy of agy-auth runs from; defaults to the loaded module. */
  installPath?: string;
  /** Runs the package manager; returns its exit status. */
  run?: (command: string, args: string[]) => number;
}

/** Tells Homebrew and npm installs apart by where the running code lives. */
export function detectInstallMethod(installPath: string): InstallMethod {
  const p = installPath.replace(/\\/g, '/');
  if (p.includes('/Cellar/agy-auth/')) return 'homebrew';
  if (p.includes('/_npx/')) return 'npx';
  if (p.includes(`/node_modules/${PACKAGE_NAME}/`)) return 'npm';
  return 'unknown';
}

export function upgradeCommandFor(method: InstallMethod): [string, string[]] | null {
  if (method === 'homebrew') return ['brew', ['upgrade', 'agy-auth']];
  if (method === 'npm') return ['npm', ['install', '--global', `${PACKAGE_NAME}@latest`]];
  return null;
}

/** True when `a` is a later x.y.z release than `b`. Pre-release tags are ignored. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function runPackageManager(command: string, args: string[]): number {
  assertNativeAllowed(`${command} ${args[0]}`);
  // npm is a .cmd script on Windows, which only a shell can start.
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function fetchLatestVersion(fetchFn: typeof fetch): Promise<string> {
  try {
    const res = await fetchFn(LATEST_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== 'string' || !/^\d+\.\d+\.\d+/.test(body.version)) {
      throw new Error('no version in the response');
    }
    return body.version;
  } catch {
    throw new CliError(
      'Could not reach the npm registry to check for a new version.',
      'update_check_failed'
    );
  }
}

export async function updateCommand(
  options: UpdateOptions = {},
  services: UpdateServices = {}
): Promise<void> {
  const latest = await fetchLatestVersion(services.fetchFn ?? globalThis.fetch);
  const installPath = services.installPath ?? fs.realpathSync(fileURLToPath(import.meta.url));
  const method = detectInstallMethod(installPath);
  const upgrade = upgradeCommandFor(method);
  const updateAvailable = isNewer(latest, VERSION);

  if (options.json) {
    printJsonResult('update', {
      current: VERSION,
      latest,
      updateAvailable,
      installMethod: method,
      command: upgrade ? [upgrade[0], ...upgrade[1]].join(' ') : null,
    });
    return;
  }

  if (!updateAvailable) {
    console.log(`\n  ${marks.ok} agy-auth ${VERSION} is the latest version.\n`);
    return;
  }

  const available = `agy-auth ${colors.green(latest)} is available (you have ${VERSION}).`;
  if (method === 'npx') {
    console.log(`\n  ${available}\n  npx runs the latest version on its next start.\n`);
    return;
  }
  if (!upgrade) {
    console.log(
      `\n  ${available}\n  This copy was not installed with npm or Homebrew; update it the way you installed it.\n`
    );
    return;
  }

  const shown = [upgrade[0], ...upgrade[1]].join(' ');
  if (options.check) {
    console.log(`\n  ${available}\n  Run ${colors.cyan('agy-auth update')} to install it.\n`);
    return;
  }

  console.log(`\n  Updating agy-auth ${VERSION} → ${latest}: ${colors.dim(shown)}\n`);
  const status = (services.run ?? runPackageManager)(upgrade[0], upgrade[1]);
  if (status !== 0) {
    throw new CliError(
      `The update did not finish: \`${shown}\` exited with ${status}.`,
      'update_failed'
    );
  }
  console.log(`\n  ${marks.ok} Updated agy-auth to ${latest}.\n`);
}
