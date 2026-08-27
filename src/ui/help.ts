import { VERSION } from '../version.js';
import { colors } from './theme.js';

export function printTopLevelHelp(all = false, version = VERSION): void {
  console.log(`${colors.cyan('agy-auth')} ${colors.cyan(version)}\n`);

  if (!all) {
    console.log(colors.cyan('Commands:'));
    writeCommandSummary(
      'list [--active] [--check] [--offline] [--json]',
      'List registered credential profiles'
    );
    writeCommandSummary(
      'switch [selector] [--json]',
      'Switch the active credential profile (cached data only)'
    );
    writeCommandSummary(
      'current [--offline] [--json]',
      'Show active profile details with live plan and quota'
    );
    writeCommandSummary(
      'login [--oauth-source <source>] [--email <email>] [options]',
      'Add or refresh a Google OAuth account'
    );
    writeCommandSummary(
      'sync [--oauth-email <email>] [--adc-email <email>] [--yes] [--json]',
      'Import active Antigravity session or local ADC credentials'
    );
    writeCommandSummary(
      'doctor [--offline] [--json]',
      'Inspect the local installation and environment'
    );

    console.log('');
    console.log(
      `  Run ${colors.cyan('`agy-auth help --all`')} to view all commands (aliases, environment, export/import).`
    );
    console.log(
      `  Run ${colors.cyan('`agy-auth <command> --help`')} for command-specific usage details.\n`
    );
    return;
  }

  console.log(colors.cyan('Commands:'));

  writeCommandSummary('--help, -h', 'Show this help');
  writeCommandSummary('--version, -V', 'Show version');
  writeCommandSummary('- [--json]', 'Switch to the previous active profile');
  writeCommandSummary(
    'list [--active] [--check] [--offline] [--json]',
    'List profiles; refreshes live plan and quota for the active OAuth profile'
  );
  writeCommandSummary(
    'switch [selector] [--json]',
    'Switch the active credential profile (cached data only, no network request)'
  );
  writeCommandDetail('switch -');
  writeCommandDetail('switch <alias|email|number|id>');
  writeCommandSummary(
    'current [--offline] [--json]',
    'Show active profile details with live plan and quota'
  );
  writeCommandSummary(
    'details [query] [--offline] [--json]',
    'Show detailed metadata for a profile with live plan and quota'
  );
  writeCommandSummary(
    'login [--oauth-source <source>] [--email <email>] [options]',
    'Add or refresh a Google OAuth account'
  );
  writeCommandSummary(
    'sync [--oauth-email <email>] [--adc-email <email>] [--yes] [--json]',
    'Import active Antigravity session or local ADC credentials'
  );
  writeCommandSummary('add [options]', 'Add an API key, service-account, or ADC profile');
  writeCommandSummary(
    'remove [selectors...] [--all] [--yes] [--json]',
    'Remove one or more profiles'
  );
  writeCommandDetail('remove <selector>...');
  writeCommandDetail('remove --all');

  console.log('');
  console.log(colors.cyan('Configuration and maintenance:'));
  writeCommandSummary('alias <set|clear>', 'Manage profile aliases');
  writeCommandSummary('project <set|clear>', 'Manage GCP project settings');
  writeCommandSummary('model <set|clear>', 'Manage model preferences');
  writeCommandSummary(
    'env [--shell posix|powershell] [--clear] [--json]',
    'Print shell export commands for active profile'
  );
  writeCommandSummary(
    'export [output] [--include-secrets] [--yes] [--json]',
    'Export profiles to a backup file'
  );
  writeCommandSummary('import <file> [--overwrite] [--json]', 'Import profiles from a backup file');
  writeCommandSummary('clean [--dry-run] [--all] [--json]', 'Remove old managed backup files');
  writeCommandSummary(
    'doctor [--offline] [--json]',
    'Inspect the local installation and environment'
  );

  console.log('');
  console.log(colors.cyan('Notes:'));
  console.log('  Run `agy-auth <command> --help` for command-specific usage details.');
  console.log('  Run `agy-auth list` to display stored credential profiles.');
  console.log('');
  console.log('  Live plan and quota reporting is experimental: it uses undocumented Antigravity');
  console.log(
    '  endpoints that may change without notice. `list`, `current` and `details` refresh'
  );
  console.log('  it over the network by default; pass `--offline` for cached data only. `switch`');
  console.log('  never makes a network request.');
  console.log('');
  console.log('  Refreshing an expired OAuth token requires AGY_OAUTH_CLIENT_ID (and optionally');
  console.log(
    '  AGY_OAUTH_CLIENT_SECRET). agy-auth ships no OAuth client ID or secret of its own.\n'
  );
}

function writeCommandSummary(command: string, description: string): void {
  console.log(`  ${colors.cyan(command)}`);
  console.log(`      ${description}`);
}

function writeCommandDetail(command: string): void {
  console.log(`      ${colors.cyan(command)}`);
}
