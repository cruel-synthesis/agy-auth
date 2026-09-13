import { Command, CommanderError } from 'commander';
import { addCommand } from './commands/add.js';
import { aliasClearCommand, aliasSetCommand } from './commands/alias.js';
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
import { CancellationError, CliError, UsageError } from './core/errors.js';
import { printTopLevelHelp } from './ui/help.js';
import { colors } from './ui/theme.js';
import { VERSION } from './version.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('agy-auth')
    .description('Manage local Antigravity and Google AI credential profiles')
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
    .command('help [command]')
    .description('Show command-specific help')
    .option('--all', 'Show all commands including advanced and maintenance utilities', false)
    .action((cmd, options) => {
      if (options?.all || cmd === '--all') {
        printTopLevelHelp(true, VERSION);
        return;
      }
      if (!cmd) {
        printTopLevelHelp(false, VERSION);
        return;
      }
      const target = program.commands.find((c) => c.name() === cmd || c.aliases().includes(cmd));
      if (target) {
        target.outputHelp();
      } else {
        throw new UsageError(`Unknown command '${cmd}'.`);
      }
    });

  // list
  program
    .command('list')
    .alias('ls')
    .description('List registered credential profiles')
    .option('-a, --active', 'Show only currently active profile')
    .option(
      '-c, --check',
      'Verify listed profiles and refresh live quota for listed OAuth profiles'
    )
    .option('--offline', 'Skip the live plan and quota refresh; show cached data only', false)
    .option('-j, --json', 'Output results as JSON')
    .action(async (options) => {
      await listCommand(options);
    });

  // switch
  program
    .command('switch')
    .alias('sw')
    .description('Switch active credential profile from cached data (makes no network request)')
    .argument('[query]', 'Profile selector (number, alias, email, id, or - for previous)')
    .option('-j, --json', 'Machine-readable output')
    .action(async (query, options) => {
      await switchCommand(query, options);
    });

  // current
  program
    .command('current')
    .alias('whoami')
    .description('Show active credential profile')
    .option('--offline', 'Skip the live plan and quota refresh; show cached data only', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await currentCommand(options);
    });

  // details / info
  program
    .command('details')
    .alias('info')
    .description('Show detailed metadata for a profile')
    .argument('[query]', 'Account selector (number, alias, email, ID)')
    .option('--offline', 'Skip the live plan and quota refresh; show cached data only', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (query, options) => {
      await detailsCommand(query, options);
    });

  // login
  program
    .command('login')
    .description('Sign in to a Google account in the browser')
    .option('--alias <alias>', 'Profile alias')
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
    .option('--email <email>', 'Account email address')
    .option('--alias <alias>', 'Account alias')
    .option('--api-key [key]', 'Gemini API key (omit value for masked entry)')
    .option('--service-account <path>', 'Path to Service Account JSON key file')
    .option('--adc [path]', 'Use Application Default Credentials (optional custom path)')
    .option('--project <id>', 'GCP project ID')
    .option('--location <location>', 'Compute region/location')
    .option('--model <model>', 'Preferred model name')
    .option('-y, --yes', 'Do not prompt', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await addCommand(options);
    });

  // remove
  program
    .command('remove')
    .alias('rm')
    .description('Remove one or more profiles from agy-auth')
    .argument('[selectors...]', 'Profile selectors to remove')
    .option('--all', 'Remove all accounts', false)
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (selectors, options) => {
      await removeCommand(selectors, options);
    });

  // alias
  const aliasCmd = program.command('alias').description('Manage profile aliases');

  aliasCmd
    .command('set')
    .description('Set an alias for an account')
    .argument('<account>', 'Account selector (number, email, ID)')
    .argument('<alias>', 'Alias name')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, alias, options) => {
      await aliasSetCommand(account, alias, options);
    });

  aliasCmd
    .command('clear')
    .description('Clear the alias from an account')
    .argument('<account>', 'Account selector (number, email, ID, alias)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, options) => {
      await aliasClearCommand(account, options);
    });

  // project
  const projectCmd = program.command('project').description('Manage GCP project settings');

  projectCmd
    .command('set')
    .description('Set the GCP project ID for an account')
    .argument('<account>', 'Account selector (number, email, ID, alias)')
    .argument('<project>', 'GCP project ID')
    .argument('[location]', 'GCP compute region/location')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, project, location, options) => {
      await projectSetCommand(account, project, location, options);
    });

  projectCmd
    .command('clear')
    .description('Clear the GCP project setting from an account')
    .argument('<account>', 'Account selector (number, email, ID, alias)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, options) => {
      await projectClearCommand(account, options);
    });

  // model
  const modelCmd = program.command('model').description('Manage model preferences');

  modelCmd
    .command('set')
    .description('Set preferred model for an account')
    .argument('<account>', 'Account selector (number, email, ID, alias)')
    .argument('<model>', 'Model name (e.g. gemini-2.5-pro)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, model, options) => {
      await modelSetCommand(account, model, options);
    });

  modelCmd
    .command('clear')
    .description('Clear the preferred model setting from an account')
    .argument('<account>', 'Account selector (number, email, ID, alias)')
    .option('-j, --json', 'Output as JSON')
    .action(async (account, options) => {
      await modelClearCommand(account, options);
    });

  // env
  program
    .command('env')
    .description('Print shell export commands for active profile')
    .option('--shell <posix|powershell>', 'Shell output format')
    .option('--clear', 'Print unset statements to reset environment', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await envCommand(options);
    });

  // export
  program
    .command('export')
    .description('Export profiles to a backup file')
    .argument('[output]', 'Output destination file path or directory')
    .option('--include-secrets', 'Include API keys and tokens in plaintext', false)
    .option('-y, --yes', 'Skip plaintext warning confirmation', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (output, options) => {
      await exportCommand({ output, ...options });
    });

  // import
  program
    .command('import')
    .description('Import profiles from a backup file')
    .argument('<file>', 'Path to export JSON file')
    .option('--overwrite', 'Overwrite existing accounts with imported metadata', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (file, options) => {
      await importCommand(file, options);
    });

  // clean
  program
    .command('clean')
    .description('Remove old managed backup files')
    .option('--dry-run', 'Show files that would be removed without deleting', false)
    .option('--all', 'Remove all managed backups (retain 0 files)', false)
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await cleanCommand(options);
    });

  // doctor
  program
    .command('doctor')
    .description('Inspect the local installation and environment')
    .option('--offline', 'Skip external network reachability probe', false)
    .option('--quota', 'Ask the quota service directly and report its answers')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      await doctorCommand(options);
    });

  return program;
}

export async function runCli(argv = process.argv, customCli?: Command): Promise<number> {
  const isJson = argv.includes('--json') || argv.includes('-j');
  const cli = customCli || createCli();

  // Configure output to silence stderr in JSON mode
  cli.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => {
      if (!isJson) {
        process.stderr.write(str);
      }
    },
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
      const commanderCode = (err as { code?: string }).code;
      if (
        commanderCode === 'commander.helpDisplayed' ||
        commanderCode === 'commander.help' ||
        commanderCode === 'commander.version'
      ) {
        return 0;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: commandName,
              ok: false,
              error: {
                code: 'invalid_usage',
                message,
              },
            },
            null,
            2
          )
        );
      } else {
        console.error(`${colors.red('Error:')} ${message}`);
      }
      return 2;
    }

    if (
      err instanceof CancellationError ||
      (err instanceof Error && err.name === 'ExitPromptError')
    ) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: commandName,
              ok: false,
              error: {
                code: 'cancelled',
                message: 'Operation cancelled.',
              },
            },
            null,
            2
          )
        );
      }
      return 130;
    }

    if (err instanceof CliError) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: commandName,
              ok: false,
              error: {
                code: err.code,
                message: err.message,
                details: Object.keys(err.details).length > 0 ? err.details : undefined,
              },
            },
            null,
            2
          )
        );
      } else {
        if (err.exitCode !== 130) {
          console.error(`${colors.red('Error:')} ${err.message}`);
        }
      }
      return err.exitCode;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: commandName,
            ok: false,
            error: {
              code: 'internal_error',
              message,
            },
          },
          null,
          2
        )
      );
    } else {
      console.error(`${colors.red('Error:')} ${message}`);
    }
    return 1;
  }
}
