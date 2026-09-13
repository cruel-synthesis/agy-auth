import { VERSION } from '../version.js';
import { colors } from './theme.js';

/** A command and what it does, rendered as one aligned row. */
type CommandRow = [command: string, description: string];

const ACCOUNT_COMMANDS: CommandRow[] = [
  ['add', 'Add the account signed in to Antigravity'],
  ['list', 'Show saved accounts, plan and quota'],
  ['switch [account]', 'Switch to a saved account'],
  ['current', 'Show the account in use'],
  ['remove [account...]', 'Remove saved accounts'],
  ['doctor', 'Check for problems'],
];

const ALL_ACCOUNT_COMMANDS: CommandRow[] = [
  ['add', 'Add the account signed in to Antigravity'],
  ['add --api-key', 'Add an API key, service-account, or ADC profile'],
  ['login', 'Sign in to another Google account in a browser'],
  ['list', 'Show saved accounts, plan and quota'],
  ['switch [account]', 'Switch to a saved account'],
  ['switch -', 'Switch back to the previous account'],
  ['current', 'Show the account in use'],
  ['details [account]', 'Show everything stored for one account'],
  ['remove [account...]', 'Remove saved accounts'],
  ['doctor', 'Check for problems'],
];

const MAINTENANCE_COMMANDS: CommandRow[] = [
  ['alias <set|clear>', 'Set or clear an account alias'],
  ['project <set|clear>', 'Set or clear the GCP project'],
  ['model <set|clear>', 'Set or clear the preferred model'],
  ['env', 'Print shell export commands for the active account'],
  ['export [file]', 'Write a backup of saved accounts'],
  ['import <file>', 'Read a backup of saved accounts'],
  ['clean', 'Delete old managed backup files'],
];

const OTHER_COMMANDS: CommandRow[] = [
  ['--version, -V', 'Show version'],
  ['--help, -h', 'Show this help'],
];

export function printTopLevelHelp(all = false, version = VERSION): void {
  console.log(`${colors.cyan('agy-auth')} ${colors.cyan(version)}\n`);

  if (!all) {
    console.log(colors.cyan('Commands:'));
    writeCommandRows(ACCOUNT_COMMANDS);
    console.log('');
    console.log(colors.cyan('Notes:'));
    console.log('  Run `agy-auth help --all` for every command.');
    console.log('  Run `agy-auth <command> --help` for options and examples.\n');
    return;
  }

  console.log(colors.cyan('Accounts:'));
  writeCommandRows(ALL_ACCOUNT_COMMANDS);

  console.log('');
  console.log(colors.cyan('Configuration and maintenance:'));
  writeCommandRows(MAINTENANCE_COMMANDS);

  console.log('');
  console.log(colors.cyan('Other:'));
  writeCommandRows(OTHER_COMMANDS);

  console.log('');
  console.log(colors.cyan('Notes:'));
  console.log('  Run `agy-auth <command> --help` for options and examples.');
  console.log('');
  console.log('  Live plan and quota reporting is experimental: it uses undocumented Antigravity');
  console.log('  endpoints that may change without notice. `list`, `current` and `details`');
  console.log('  refresh it over the network by default; pass `--offline` for cached data only.');
  console.log('  `switch` never makes a network request.');
  console.log('');
  console.log('  Refreshing an expired OAuth token requires AGY_OAUTH_CLIENT_ID (and optionally');
  console.log(
    '  AGY_OAUTH_CLIENT_SECRET). agy-auth ships no OAuth client ID or secret of its own.\n'
  );
}

/** Pads before colouring so the descriptions line up regardless of ANSI codes. */
function writeCommandRows(rows: CommandRow[]): void {
  const width = Math.max(...rows.map(([command]) => command.length));
  for (const [command, description] of rows) {
    console.log(`  ${colors.cyan(command.padEnd(width))}  ${description}`);
  }
}
