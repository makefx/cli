#!/usr/bin/env node
import process from 'node:process';
import { SERVICE_NAME } from './lib/project.ts';
import { CLI_VERSION } from './lib/version.ts';
import { CONVENIENCE_USAGE, handleExport, handleOpen } from './commands/convenience.ts';
import { handleCreate } from './commands/create.ts';
import { handleLogin } from './commands/login.ts';
import { handleLogout } from './commands/logout.ts';
import { handleMcp } from './commands/mcp.ts';
import { handleMutationCommand, mutationCommandUsage, type MutationCommand } from './commands/mutate.ts';
import { handlePurchaseCommand, purchaseCommandUsage, type PurchaseCommand } from './commands/purchase.ts';
import { commandUsage, handleDataCommand, type DataCommand } from './commands/read.ts';
import { handleTransferCommand, transferCommandUsage } from './commands/transfer.ts';
import { reportCommandError } from './lib/command-error.ts';
import { CliUsageError } from './lib/errors.ts';
import type { ParsedArgs } from './lib/types.ts';
import { parseArgs } from './lib/utils.ts';
import { audioCommandUsage, handleAudioCommand } from './commands/audio.ts';
import {
  handleSpaceVisibilityCommand,
  spaceVisibilityUsage,
  type SpaceVisibilityCommand,
} from './commands/space-visibility.ts';

async function main() {
  const [, , command, ...args] = process.argv;

  try {
    if (!command || command === '--help') {
      printHelp();
      return;
    }
    if (command === '--version' || command === 'version') {
      console.log(CLI_VERSION);
      return;
    }
    if (command === 'help') {
      const [topic, nested] = args;
      if (topic) printTopicHelp(topic, nested);
      else printHelp();
      return;
    }

    const parsed = parseArgs(args);
    await dispatchCommand(command, parsed);
  } catch (error) {
    const parsed = parseArgs(args);
    process.exitCode = reportCommandError(error, parsed.options.json === 'true', {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }
}

function printHelp(): void {
  console.log(`
${SERVICE_NAME} CLI ${CLI_VERSION}

Usage: makefx <command> [options]

Commands:
  login [--env ENV]             Sign in through the browser
  logout [--env ENV]            Revoke and remove stored credentials
  mcp [--env ENV]               Relay stdio JSON-RPC to /mcp
  account [--account ID]        Show balance and active holds
  purchase create --account ID --product PRODUCT --request-id ID
                                Prepare a credit purchase without charging a card
  purchase get --purchase ID    Read credit purchase status
  profile get                   Show the signed-in profile
  profile update --name NAME    Change the signed-in display name
  health                        Check service reachability and environment
  spaces [--account ID] [--query TEXT] [--limit N]
                                List available spaces
  space create --name NAME [--account ID] [--id ID]
                                Create a space in an account you can edit
  space get --space S [--starred-only]
                                Read every asset, link, and recipe in a space
  space update --space S --name TEXT
                                Rename a space; every address it has worn keeps working
  space publish --space S       Publish a read-only snapshot (account owner only)
  space unpublish --space S     Withdraw the public snapshot (account owner only)
  space delete --space S        Soft-delete a space (account owner only)
  voices sync --account ACCOUNT Refresh the account's ElevenLabs voices
  models [--space S] [--kind K] [--family F]
                                List the model catalog for the payer
  estimate --kind K --model M [--from-asset A] [--recipe-mode current|exact]
                                Quote creation or replay before spending credits
  create --space S --kind K --model M
                                Validate the payer catalog, then create assets
  upload --space S --kind K --file PATH
                                Stream a local file through a signed URL
  download ASSET --space S      Stream ready media to a new local file
  asset get --space S --asset A Read an asset and refresh its URLs
  asset update --space S --asset A
                                Update asset metadata
  asset delete --space S --asset A
                                Soft-delete an asset
  describe --space S --asset A  Describe reusable visual traits
  audio align ASSET --space S   Align or re-align unchanged ready audio
  audio timings ASSET --space S Read or save current canonical timings
  link --space S --from A --to B
                                Link two assets on the canvas
  unlink --space S (--link L | --from A --to B)
                                Remove a canvas link
  export --space S [--out PATH] Export a space document via export_space
  open SPACE                    Print and open a canonical space URL
  open ASSET --space S          Print and open a canonical asset URL

Common options:
  --env production|stage|local  Select credentials and endpoint (default: production)
  --local                       Shortcut for --env local
  --json                        Print unchanged structured tool output where supported
  --help                        Show command help without authenticating
  --version                     Print the installed CLI version

Open control:
  --no-open                     Print the URL without launching a browser
  MAKEFX_NO_OPEN=1              Environment equivalent for scripts

Exit codes:
  0 success; 1 tool, network, or file error; 2 invalid command usage

Examples:
  makefx login --env production
  makefx create --space alv/flight --kind image --model image/frame \\
    --ref as_video:source --param t=last --wait
  makefx upload --space alv/flight --kind image --file ./frame.png \\
    --param source=camera --ref as_board:reference
  makefx export --space alv/flight --out ./flight.json

Run makefx <command> --help, makefx space help, makefx asset help, makefx audio help, or makefx voices help for exact arguments.
`);
}

function helpForCommand(command: string): string {
  const staticUsage: Record<string, string> = {
    login: 'Usage: makefx login [--env production|stage|local] [--local]\n\nPrints the browser authorization URL and loopback callback port (8765).\nFor remote hosts, also prints an SSH tunnel command to run on your browser computer.',
    logout: 'Usage: makefx logout [--env production|stage|local] [--local]',
    mcp: 'Usage: makefx mcp [--env production|stage|local] [--local]',
    create:
      'Usage: makefx create --space ACCOUNT/SPACE --kind image|video|audio --model MODEL [--prompt TEXT] [--ref ASSET:SLOT]... [--param NAME=VALUE]... [--count 1..8] [--name TEXT] [--seed INTEGER] [--position JSON] [--tags JSON] [--note TEXT] [--from-asset ASSET] [--recipe-mode current|exact] [--request-id ID] [--wait] [--json]\nRepeated --ref values preserve left-to-right order as reference order 0, 1, and so on. Reads the live catalog for the paying Space before calling create_asset.',
    export: `Usage: makefx ${CONVENIENCE_USAGE.export}`,
    open: `Usage: makefx ${CONVENIENCE_USAGE.open}\nPrints web_url before opening. Set MAKEFX_NO_OPEN=1 for scripts.`,
  };
  if (command in staticUsage) return staticUsage[command] as string;
  if (command === 'upload' || command === 'download') return transferCommandUsage(command);
  if (command === 'purchase create' || command === 'purchase get') {
    return purchaseCommandUsage(command);
  }
  if (command === 'audio align' || command === 'audio timings') return audioCommandUsage(command);
  if (command === 'space publish' || command === 'space unpublish') {
    return spaceVisibilityUsage(command);
  }
  if (['describe', 'link', 'unlink', 'asset update', 'asset delete', 'profile update'].includes(command)) {
    return mutationCommandUsage(command as MutationCommand);
  }
  if (
    [
      'account',
      'spaces',
      'space create',
      'space get',
      'space update',
      'space delete',
      'models',
      'estimate',
      'asset get',
      'profile get',
      'health',
    ].includes(command)
  ) {
    return commandUsage(command as DataCommand);
  }
  throw new CliUsageError(`Unknown help topic: ${command}`);
}

function printTopicHelp(topic: string, nested?: string): void {
  if (topic === 'voices') {
    if (nested && nested !== 'sync') throw new CliUsageError(`Unknown voices command: ${nested}`);
    console.log(mutationCommandUsage('voices sync'));
    return;
  }
  if (topic === 'audio') {
    if (nested === 'align' || nested === 'timings') console.log(audioCommandUsage(`audio ${nested}`));
    else if (nested) throw new CliUsageError(`Unknown audio command: ${nested}`);
    else console.log([audioCommandUsage('audio align'), audioCommandUsage('audio timings')].join('\n'));
    return;
  }
  if (topic === 'space' || topic === 'asset' || topic === 'purchase' || topic === 'profile') {
    if (nested) console.log(helpForCommand(`${topic} ${nested}`));
    else printNestedHelp(topic);
    return;
  }
  console.log(helpForCommand(topic));
}

async function dispatchCommand(command: string, parsed: ParsedArgs): Promise<void> {
  if (
    parsed.options.help === 'true' &&
    command !== 'space' &&
    command !== 'asset' &&
    command !== 'audio' &&
    command !== 'voices' &&
    command !== 'purchase' &&
    command !== 'profile'
  ) {
    console.log(helpForCommand(command));
    return;
  }

  switch (command) {
    case 'login':
      await handleLogin(parsed);
      break;
    case 'logout':
      await handleLogout(parsed);
      break;
    case 'mcp':
      await handleMcp(parsed);
      break;
    case 'create':
      await handleCreate(parsed);
      break;
    case 'export':
      await handleExport(parsed);
      break;
    case 'open':
      await handleOpen(parsed);
      break;
    case 'upload':
    case 'download':
      await handleTransferCommand(command, parsed);
      break;
    case 'describe':
    case 'link':
    case 'unlink':
      await handleMutationCommand(command, parsed);
      break;
    case 'voices': {
      const [subcommand, ...positionals] = parsed.positionals;
      if (!subcommand || subcommand === 'help') {
        console.log(mutationCommandUsage('voices sync'));
        break;
      }
      if (subcommand !== 'sync') throw new CliUsageError(`Unknown voices command: ${subcommand}`);
      if (parsed.options.help === 'true') {
        console.log(mutationCommandUsage('voices sync'));
        break;
      }
      await handleMutationCommand('voices sync', { ...parsed, positionals });
      break;
    }
    case 'audio': {
      const [subcommand, ...positionals] = parsed.positionals;
      if (!subcommand || subcommand === 'help') {
        console.log([audioCommandUsage('audio align'), audioCommandUsage('audio timings')].join('\n'));
        break;
      }
      const nested = `audio ${subcommand}`;
      if (nested !== 'audio align' && nested !== 'audio timings') {
        throw new CliUsageError(`Unknown audio command: ${subcommand}`);
      }
      if (parsed.options.help === 'true') {
        console.log(audioCommandUsage(nested));
        break;
      }
      await handleAudioCommand(nested, { ...parsed, positionals });
      break;
    }
    case 'account':
    case 'spaces':
    case 'models':
    case 'estimate':
    case 'health':
      await handleDataCommand(command, parsed);
      break;
    case 'purchase':
    case 'profile': {
      const [subcommand, ...positionals] = parsed.positionals;
      if (!subcommand || subcommand === 'help') {
        printNestedHelp(command);
        break;
      }
      const nested = `${command} ${subcommand}` as DataCommand | MutationCommand | PurchaseCommand;
      const allowed =
        command === 'purchase' ? ['purchase create', 'purchase get'] : ['profile get', 'profile update'];
      if (!allowed.includes(nested)) {
        throw new CliUsageError(`Unknown ${command} command: ${subcommand}`);
      }
      if (parsed.options.help === 'true') {
        console.log(helpForCommand(nested));
        break;
      }
      const nestedParsed = { ...parsed, positionals };
      if (nested === 'purchase create' || nested === 'purchase get') {
        await handlePurchaseCommand(nested, nestedParsed);
      } else if (nested === 'profile update') {
        await handleMutationCommand(nested, nestedParsed);
      } else {
        await handleDataCommand(nested as DataCommand, nestedParsed);
      }
      break;
    }
    case 'space':
    case 'asset': {
      const [subcommand, ...positionals] = parsed.positionals;
      if (!subcommand || subcommand === 'help') {
        printNestedHelp(command);
        break;
      }
      const nested = `${command} ${subcommand}` as DataCommand | MutationCommand | SpaceVisibilityCommand;
      if (
        ![
          'space create',
          'space get',
          'space update',
          'space publish',
          'space unpublish',
          'space delete',
          'asset get',
          'asset update',
          'asset delete',
        ].includes(nested)
      ) {
        throw new CliUsageError(`Unknown ${command} command: ${subcommand}`);
      }
      if (parsed.options.help === 'true') {
        console.log(helpForCommand(nested));
        break;
      }
      const nestedParsed = { ...parsed, positionals };
      if (nested === 'space publish' || nested === 'space unpublish') {
        await handleSpaceVisibilityCommand(nested, nestedParsed);
      } else if (nested === 'space update' || nested === 'asset update' || nested === 'asset delete') {
        await handleMutationCommand(nested, nestedParsed);
      } else {
        await handleDataCommand(nested as DataCommand, nestedParsed);
      }
      break;
    }
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}

function printNestedHelp(command: 'space' | 'asset' | 'purchase' | 'profile'): void {
  if (command === 'purchase') {
    console.log([purchaseCommandUsage('purchase create'), purchaseCommandUsage('purchase get')].join('\n'));
    return;
  }
  if (command === 'profile') {
    console.log([commandUsage('profile get'), mutationCommandUsage('profile update')].join('\n'));
    return;
  }
  const commands: DataCommand[] =
    command === 'space' ? ['space create', 'space get', 'space delete'] : ['asset get'];
  const usage = commands.map(commandUsage);
  if (command === 'space') {
    usage.push(
      mutationCommandUsage('space update'),
      spaceVisibilityUsage('space publish'),
      spaceVisibilityUsage('space unpublish'),
    );
  }
  if (command === 'asset') {
    usage.push(mutationCommandUsage('asset update'), mutationCommandUsage('asset delete'));
  }
  console.log(usage.join('\n'));
}

void main();
