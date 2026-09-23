import { randomUUID } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../lib/auth.ts';
import { CliUsageError } from '../lib/errors.ts';
import { authenticatedToolClient, type ToolClient } from '../lib/tool-client.ts';
import type { ParsedArgs } from '../lib/types.ts';

type ConvenienceDependencies = {
  client: (parsed: ParsedArgs) => Promise<ToolClient>;
  write: (text: string) => void;
  openUrl: (url: string) => Promise<void>;
  id: () => string;
  env: NodeJS.ProcessEnv;
};

const defaults: ConvenienceDependencies = {
  client: authenticatedToolClient,
  write: (text) => process.stdout.write(`${text}\n`),
  openUrl: openBrowser,
  id: randomUUID,
  env: process.env,
};

const GLOBAL_OPTIONS = ['env', 'local', 'json', 'help'];

export const CONVENIENCE_USAGE = {
  export: 'export --space ACCOUNT/SPACE [--starred-only] [--out PATH] [--json]',
  open: 'open SPACE | open ASSET --space ACCOUNT/SPACE [--no-open]',
} as const;

function usage(command: keyof typeof CONVENIENCE_USAGE): string {
  return `Usage: makefx ${CONVENIENCE_USAGE[command]}`;
}

function optional(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === 'true') throw new CliUsageError(`--${name} requires a value.`);
  return value;
}

function required(parsed: ParsedArgs, name: string, command: keyof typeof CONVENIENCE_USAGE): string {
  const value = optional(parsed, name);
  if (!value) throw new CliUsageError(`${command} requires --${name} <value>.`);
  return value;
}

function rejectUnexpected(
  parsed: ParsedArgs,
  command: keyof typeof CONVENIENCE_USAGE,
  options: string[],
): void {
  const allowed = new Set([...GLOBAL_OPTIONS, ...options]);
  const unexpected = Object.keys(parsed.options).find((option) => !allowed.has(option));
  if (unexpected) throw new CliUsageError(`Unknown option --${unexpected}. ${usage(command)}`);
}

async function destinationAvailable(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Destination already exists: ${path}`);
}

async function publishJson(
  destination: string,
  value: Record<string, unknown>,
  id: () => string,
): Promise<void> {
  await destinationAvailable(destination);
  const temporary = `${destination}.makefx-${id()}.tmp`;
  let published = false;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    await link(temporary, destination);
    published = true;
    await unlink(temporary);
  } finally {
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}

export async function handleExport(
  parsed: ParsedArgs,
  dependencies: ConvenienceDependencies = defaults,
): Promise<void> {
  rejectUnexpected(parsed, 'export', ['space', 'starred-only', 'out']);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`export does not accept "${parsed.positionals[0]}". ${usage('export')}`);
  }
  const space = required(parsed, 'space', 'export');
  const out = optional(parsed, 'out');
  const destination = out ? resolve(out) : undefined;
  if (destination) await destinationAvailable(destination);

  const client = await dependencies.client(parsed);
  const result = await client.call('export_space', {
    space_id: space,
    starred_only: parsed.options['starred-only'] === 'true',
  });

  if (!destination) {
    dependencies.write(JSON.stringify(result, null, 2));
    return;
  }
  await publishJson(destination, result, dependencies.id);
  dependencies.write(parsed.options.json === 'true' ? JSON.stringify(result, null, 2) : destination);
}

function browserDisabled(parsed: ParsedArgs, env: NodeJS.ProcessEnv): boolean {
  if (parsed.options['no-open'] === 'true') return true;
  const value = env.MAKEFX_NO_OPEN?.toLowerCase();
  return value !== undefined && !['', '0', 'false', 'no'].includes(value);
}

export async function handleOpen(
  parsed: ParsedArgs,
  dependencies: ConvenienceDependencies = defaults,
): Promise<void> {
  rejectUnexpected(parsed, 'open', ['space', 'no-open']);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(`open requires one space or asset id. ${usage('open')}`);
  }
  const target = parsed.positionals[0];
  const space = optional(parsed, 'space');
  const isSpace = target.includes('/');
  if (isSpace && space) {
    throw new CliUsageError(`A space target does not accept --space. ${usage('open')}`);
  }
  if (!isSpace && !space) {
    throw new CliUsageError(`An asset target requires --space <value>. ${usage('open')}`);
  }

  const client = await dependencies.client(parsed);
  const result = await client.call(
    isSpace ? 'get_space' : 'get_asset',
    isSpace
      ? { space_id: target, starred_only: false }
      : { space_id: space, asset_id: target, wait_seconds: 0 },
  );
  const webUrl = result.web_url;
  if (typeof webUrl !== 'string') throw new Error('The tool returned no canonical web_url.');

  dependencies.write(webUrl);
  if (!browserDisabled(parsed, dependencies.env)) await dependencies.openUrl(webUrl);
}
