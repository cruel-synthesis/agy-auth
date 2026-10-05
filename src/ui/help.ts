import { VERSION } from '../version.js';
import { colors } from './theme.js';

/**
 * A command and what it does, rendered as one aligned row. `common` marks the
 * rows the short help shows, so the two listings cannot drift apart.
 */
type CommandRow = [command: string, description: string, common?: true];

const ALL_ACCOUNT_COMMANDS: CommandRow[] = [
  ['add', 'Add the account signed in to Antigravity', true],
  ['login', 'Sign in to another Google account in a browser', true],
  ['add --api-key', 'Add an API key, service account, or ADC credential'],
  ['list', 'Show saved accounts, plan and quota', true],
  ['switch [account]', 'Switch to a saved account', true],
  ['switch -', 'Switch back to the previous account', true],
  ['auto', 'Switch to the account with the most quota at risk', true],
  ['auto --watch', 'Keep switching as each account runs out'],
  ['current', 'Show the account in use', true],
  ['details [account]', 'Show everything stored for one account'],
  ['remove [account...]', 'Remove saved accounts', true],
  ['doctor', 'Check for problems', true],
];

const ACCOUNT_COMMANDS: CommandRow[] = ALL_ACCOUNT_COMMANDS.filter(([, , common]) => common);

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

const EXAMPLES: CommandRow[] = [
  ['agy-auth login --alias work', 'Sign in to another account and call it "work"'],
  ['agy-auth switch work', 'Put Antigravity on it'],
  ['agy-auth -', 'Switch back to the previous account'],
];

export function printTopLevelHelp(all = false, version = VERSION): void {
  console.log(`${colors.cyanBold('agy-auth')} ${colors.dim(version)}`);
  console.log(
    'Keep several Google accounts signed in for Antigravity and switch in one command.\n'
  );
  console.log(`${colors.cyan('Usage:')} agy-auth <command> [options]\n`);

  if (!all) {
    console.log(colors.cyan('Commands:'));
    writeCommandRows(ACCOUNT_COMMANDS);
    console.log('');
    console.log(colors.cyan('Examples:'));
    writeCommandRows(EXAMPLES);
    console.log('');
    console.log(
      `${colors.dim('Run `agy-auth help --all` for every command, `agy-auth <command> --help` for its options.')}\n`
    );
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
  console.log('  Run `agy-auth <command> --help` for its options.');
  console.log('');
  console.log('  Live plan and quota reporting is experimental: it uses undocumented Antigravity');
  console.log('  endpoints that may change without notice. `list`, `current` and `details`');
  console.log('  refresh it over the network by default; pass `--offline` for cached data only.');
  console.log('  `switch` never makes a network request.');
  console.log('');
  console.log("  Sign-in and renewal use Antigravity's own OAuth client, the only one Google");
  console.log('  answers with a plan and a quota. Set AGY_OAUTH_CLIENT_ID to use your own');
  console.log('  instead, accepting that the account will report neither.\n');
}

/** Pads before colouring so the descriptions line up regardless of ANSI codes. */
function writeCommandRows(rows: CommandRow[]): void {
  const width = Math.max(...rows.map(([command]) => command.length));
  for (const [command, description] of rows) {
    console.log(`  ${colors.cyan(command.padEnd(width))}  ${description}`);
  }
}
