import { Command, CommanderError } from 'commander';
import { ZodError } from 'zod';
import { addCommand } from './commands/add.js';
import { aliasClearCommand, aliasSetCommand } from './commands/alias.js';
import { autoCommand } from './commands/auto.js';
import { cleanCommand } from './commands/clean.js';
import { currentCommand } from './commands/current.js';
import { detailsCommand } from './commands/details.js';
import { doctorCommand } from './commands/doctor.js';
import { envCommand } from './commands/env.js';
import { exportCommand } from './commands/export.js';
import { importCommand } from './commands/import.js';
import { listCommand } from './commands/list.js';
import { loginCommand } from './commands/login.js';
import { modelClearCommand, modelSetCommand } from './commands/model.js';
import { projectClearCommand, projectSetCommand } from './commands/project.js';
import { removeCommand } from './commands/remove.js';
import { switchCommand } from './commands/switch.js';
import {
  CancellationError,
  CliError,
  UsageError,
  describeSchemaFailure,
  errorMessage,
} from './core/errors.js';
import { printTopLevelHelp } from './ui/help.js';
import { colors } from './ui/theme.js';
import { VERSION } from './version.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('agy-auth')
    .description('Manage local Antigravity and Google AI accounts')
    .version(VERSION, '-V, --version', 'Show version')
    .helpOption('-h, --help', 'Show this help')
    .exitOverride();

  // Custom help output for top-level
  program.helpInformation = () => {
    printTopLevelHelp(false, VERSION);
    return '';
  };

  // help subcommand
  program
    .command('help [command...]')
    .description('Show command-specific help')
    .option('--all', 'Show all commands including advanced and maintenance utilities')
    .action((words: string[], options) => {
      if (options?.all || words[0] === '--all') {
        printTopLevelHelp(true, VERSION);
        return;
      }
      if (words.length === 0) {
        printTopLevelHelp(false, VERSION);
        return;
      }
      // `help alias set` names a subcommand after its group.
      let target: Command = program;
      for (const word of words) {
        const next = target.commands.find((c) => c.name() === word || c.aliases().includes(word));
        if (!next) throw new UsageError(`Unknown command '${words.join(' ')}'.`);
        target = next;
      }
      target.outputHelp();
    });

  // list
  program
    .command('list')
    .alias('ls')
    .description('Show saved accounts, plan and quota')
    .option('-a, --active', 'Show only the active account')
    .option('-c, --check', 'Verify listed accounts and refresh live quota for OAuth accounts')
    .option('--offline', 'Skip the live plan and quota refresh; show cached data only')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await listCommand(options);
    });

  // switch
  program
    .command('switch')
    .alias('sw')
    .description('Switch to a saved account (makes no network request)')
    .argument('[query]', 'Account selector (number, alias, email, ID, or - for previous)')
    .option('-j, --json', 'Output as JSON')
    .action(async (query, options) => {
      await switchCommand(query, options);
    });

  // auto
  program
    .command('auto')
    .alias('best')
    .description('Switch to the account whose quota is most at risk of going to waste')
    .option('-n, --dry-run', 'Show the ranking and the choice without switching')
    .option('-w, --watch', 'Keep running and switch whenever the account in use runs out')
    .option('--interval <minutes>', 'Minutes between checks while watching (default: 5)')
    .option('--offline', 'Decide from cached quota only; make no network request')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await autoCommand(options);
    });

  // current
  program
    .command('current')
    .alias('whoami')
    .description('Show the account in use')
    .option('--offline', 'Skip the live plan and quota refresh; show cached data only')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await currentCommand(options);
    });

  // details / info
  program
    .command('details')
    .alias('info')
    .description('Show everything stored for one account')
    .argument('[query]', 'Account selector (number, alias, email, ID)')
    .option('--offline', 'Skip the live plan and quota refresh; show cached data only')
    .option('-j, --json', 'Output as JSON')
    .action(async (query, options) => {
      await detailsCommand(query, options);
    });

  // login
  program
    .command('login')
    .description('Sign in to another Google account in a browser')
    .option('--alias <alias>', 'Account alias')
    .option('--project <id>', 'GCP project ID')
    .option('--location <location>', 'Compute region/location')
    .option('--model <model>', 'Preferred model name')
    .action(async (options) => {
      await loginCommand(options);
    });

  // add
  program
    .command('add')
    .description('Add the account signed in to Antigravity, or another credential')
    .option('--alias <alias>', 'Account alias')
    .option('--email <email>', 'Account email address')
    .option('--api-key [key]', 'Gemini API key (omit value for masked entry)')
    .option('--service-account <path>', 'Path to Service Account JSON key file')
    .option('--adc [path]', 'Use Application Default Credentials (optional custom path)')
    .option('--project <id>', 'GCP project ID')
    .option('--location <location>', 'Compute region/location')
    .option('--model <model>', 'Preferred model name')
    .option('-y, --yes', 'Do not prompt')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await addCommand(options);
    });

  // remove
  program
    .command('remove')
    .alias('rm')
    .description('Remove saved accounts')
    .argument('[selectors...]', 'Account selectors (number, alias, email, ID)')
    .option('--all', 'Remove all accounts')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-j, --json', 'Output as JSON')
    .action(async (selectors, options) => {
      await removeCommand(selectors, options);
    });

  // alias
  const aliasCmd = program
    .command('alias')
    .description('Set or clear an account alias')
    .helpCommand('help [command]', 'Show help for a subcommand');

  aliasCmd
    .command('set')
    .description('Set the alias for an account')
    .argument('<account>', 'Account selector (number, alias, email, ID)')
    .argument('<alias>', 'Alias name')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, alias, options) => {
      await aliasSetCommand(account, alias, options);
    });

  aliasCmd
    .command('clear')
    .description('Clear the alias for an account')
    .argument('<account>', 'Account selector (number, alias, email, ID)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, options) => {
      await aliasClearCommand(account, options);
    });

  // project
  const projectCmd = program
    .command('project')
    .description('Set or clear the GCP project')
    .helpCommand('help [command]', 'Show help for a subcommand');

  projectCmd
    .command('set')
    .description('Set the GCP project and optional location for an account')
    .argument('<account>', 'Account selector (number, alias, email, ID)')
    .argument('<project>', 'GCP project ID')
    .argument('[location]', 'GCP compute region/location')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, project, location, options) => {
      await projectSetCommand(account, project, location, options);
    });

  projectCmd
    .command('clear')
    .description('Clear the GCP project and location for an account')
    .argument('<account>', 'Account selector (number, alias, email, ID)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, options) => {
      await projectClearCommand(account, options);
    });

  // model
  const modelCmd = program
    .command('model')
    .description('Set or clear the preferred model')
    .helpCommand('help [command]', 'Show help for a subcommand');

  modelCmd
    .command('set')
    .description('Set the preferred model for an account')
    .argument('<account>', 'Account selector (number, alias, email, ID)')
    .argument('<model>', 'Model name (e.g. gemini-2.5-pro)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, model, options) => {
      await modelSetCommand(account, model, options);
    });

  modelCmd
    .command('clear')
    .description('Clear the preferred model for an account')
    .argument('<account>', 'Account selector (number, alias, email, ID)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, options) => {
      await modelClearCommand(account, options);
    });

  // env
  program
    .command('env')
    .description('Print shell export commands for the active account')
    .option(
      '--shell <posix|powershell>',
      'Shell output format (default: powershell on Windows, posix elsewhere)'
    )
    .option('--clear', 'Print unset statements to reset environment')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await envCommand(options);
    });

  // export
  program
    .command('export')
    .description('Write a backup of saved accounts')
    .argument('[output]', 'Output destination file path or directory')
    .option('--include-secrets', 'Include API keys and tokens in plaintext')
    .option('-y, --yes', 'Skip plaintext warning confirmation')
    .option('-j, --json', 'Output as JSON')
    .action(async (output, options) => {
      await exportCommand({ output, ...options });
    });

  // import
  program
    .command('import')
    .description('Read a backup of saved accounts')
    .argument('<file>', 'Path to export JSON file')
    .option(
      '--overwrite',
      'Update existing accounts from the file, including any credentials it holds'
    )
    .option('-j, --json', 'Output as JSON')
    .action(async (file, options) => {
      await importCommand(file, options);
    });

  // clean
  program
    .command('clean')
    .description('Delete old managed backup files')
    .option('--dry-run', 'Show files that would be removed without deleting')
    .option('--all', 'Remove every managed backup, keeping none')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await cleanCommand(options);
    });

  // doctor
  program
    .command('doctor')
    .description('Check for problems')
    .option('--offline', 'Skip external network reachability probe')
    .option('--quota', 'Ask the quota service directly and report its answers')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await doctorCommand(options);
    });

  return program;
}

/** Why Commander showed a group's help as an error: no subcommand, or `help` named an unknown one. */
function missingSubcommandMessage(words: string[]): string {
  const at = words.indexOf('help');
  const named = at >= 0 ? words[at + 1] : undefined;
  if (named === undefined) return `\`${words[0]}\` needs a subcommand.`;
  return at === 0
    ? `Unknown command '${named}'.`
    : `Unknown \`${words[0]}\` subcommand '${named}'.`;
}

export async function runCli(argv = process.argv, customCli?: Command): Promise<number> {
  // Only Commander knows whether a `-j` or `--json` was the flag (also inside a
  // cluster such as `-yj`) or an option's value, as in `env --shell --json`. Once
  // a command runs, the error path answers in the shape it ran in. A parse error
  // can stop before the flag is reached, so there the raw words decide.
  let jsonFlag = false;
  let streaming = false;
  let parsed = false;
  const jsonWord = argv.includes('--json') || argv.includes('-j');
  const isJson = (): boolean => jsonFlag || (!parsed && jsonWord);
  const cli = customCli || createCli();
  const listenForJson = (command: Command): void => {
    command.on('option:json', () => {
      jsonFlag = true;
    });
    command.on('option:watch', () => {
      streaming = true;
    });
    for (const sub of command.commands) listenForJson(sub);
  };
  listenForJson(cli);
  cli.hook('preAction', () => {
    parsed = true;
  });

  // Commander writes its own error line and then throws it. That line is dropped
  // and reported once below, in the shape every other failure uses. What else it
  // writes to stderr is the help for a group run without a subcommand.
  cli.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => {
      if (!isJson()) process.stderr.write(str);
    },
    outputError: () => {},
  });

  // Derive command name from raw args
  let commandName = 'agy-auth';
  const nonFlagArgs = argv.slice(2).filter((a) => !a.startsWith('-'));
  if (nonFlagArgs.length > 0) {
    if (nonFlagArgs[0] === 'alias' && nonFlagArgs[1]) {
      commandName = `alias ${nonFlagArgs[1]}`;
    } else if (nonFlagArgs[0] === 'project' && nonFlagArgs[1]) {
      commandName = `project ${nonFlagArgs[1]}`;
    } else if (nonFlagArgs[0] === 'model' && nonFlagArgs[1]) {
      commandName = `model ${nonFlagArgs[1]}`;
    } else {
      commandName = nonFlagArgs[0];
    }
  }

  // Handle shortcut `agy-auth -` by rewriting to `agy-auth switch -`
  let rawArgs = [...argv];
  if (rawArgs[2] === '-') {
    rawArgs = [rawArgs[0], rawArgs[1], 'switch', ...rawArgs.slice(2)];
    commandName = 'switch';
  }

  // A watch writes one JSON object per line, so its last word must be one too.
  const printJsonError = (error: { code: string; message: string; details?: unknown }): void => {
    console.log(
      JSON.stringify(
        { schemaVersion: 1, command: commandName, ok: false, error },
        null,
        streaming ? undefined : 2
      )
    );
  };

  // Configure commander error handling
  cli.exitOverride();

  try {
    await cli.parseAsync(rawArgs);
    return 0;
  } catch (err: unknown) {
    if (
      err instanceof CommanderError ||
      (err &&
        typeof err === 'object' &&
        'code' in err &&
        typeof err.code === 'string' &&
        err.code.startsWith('commander.'))
    ) {
      const { code: commanderCode, exitCode } = err as { code?: string; exitCode?: number };
      if (commanderCode === 'commander.helpDisplayed' || commanderCode === 'commander.version') {
        return 0;
      }
      // Help asked for succeeds, and so does bare `agy-auth`, which shows its
      // overview. Help shown because a group was run without one of its
      // subcommands is a usage error, and its message is only a marker.
      if (commanderCode === 'commander.help' && (exitCode === 0 || commandName === 'agy-auth')) {
        return 0;
      }
      // Commander prefixes its messages with 'error: '; ours adds its own.
      const raw = err instanceof Error ? err.message : String(err);
      const message =
        commanderCode === 'commander.help'
          ? missingSubcommandMessage(nonFlagArgs)
          : raw.replace(/^error:\s*/, '');
      if (isJson()) {
        printJsonError({ code: 'invalid_usage', message });
      } else {
        console.error(`${colors.red('Error:')} ${message}`);
      }
      return 2;
    }

    if (
      err instanceof CancellationError ||
      (err instanceof Error && err.name === 'ExitPromptError')
    ) {
      if (isJson()) {
        printJsonError({ code: 'cancelled', message: 'Operation cancelled.' });
      }
      return 130;
    }

    if (err instanceof CliError) {
      if (isJson()) {
        printJsonError({
          code: err.code,
          message: err.message,
          details: Object.keys(err.details).length > 0 ? err.details : undefined,
        });
      } else {
        if (err.exitCode !== 130) {
          console.error(`${colors.red('Error:')} ${err.message}`);
        }
      }
      return err.exitCode;
    }

    const message =
      err instanceof ZodError ? `Invalid file: ${describeSchemaFailure(err)}` : errorMessage(err);
    if (isJson()) {
      printJsonError({ code: 'internal_error', message });
    } else {
      console.error(`${colors.red('Error:')} ${message}`);
    }
    return 1;
  }
}
