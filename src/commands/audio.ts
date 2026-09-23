import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ParsedArgs } from '../lib/types.ts';
import { authenticatedToolClient, type ToolClient } from '../lib/tool-client.ts';
import { CliUsageError } from '../lib/errors.ts';

export type AudioCommand = 'audio align' | 'audio timings';

const USAGE = {
  'audio align':
    'audio align ASSET --space ACCOUNT/SPACE [TEXT | --input PATH] [--request-id ID] [--wait] [--json]',
  'audio timings': 'audio timings ASSET --space ACCOUNT/SPACE [--out PATH] [--json]',
} as const;

type Dependencies = {
  client: (parsed: ParsedArgs) => Promise<ToolClient>;
  write: (text: string) => void;
  id: () => string;
};

const defaults: Dependencies = {
  client: authenticatedToolClient,
  write: (text) => process.stdout.write(`${text}\n`),
  id: randomUUID,
};

export function audioCommandUsage(command: AudioCommand): string {
  return `Usage: makefx ${USAGE[command]}`;
}

function option(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === 'true') throw new CliUsageError(`--${name} requires a value.`);
  return value;
}

function required(parsed: ParsedArgs, name: string, command: AudioCommand): string {
  const value = option(parsed, name);
  if (!value) throw new CliUsageError(`${command} requires --${name} <value>.`);
  return value;
}

function rejectOptions(parsed: ParsedArgs, command: AudioCommand, allowed: string[]): void {
  const options = new Set(['env', 'local', 'json', 'help', ...allowed]);
  const unexpected = Object.keys(parsed.options).find((name) => !options.has(name));
  if (unexpected) throw new CliUsageError(`Unknown option --${unexpected}. ${audioCommandUsage(command)}`);
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

async function publishJson(path: string, value: unknown, id: () => string): Promise<void> {
  await destinationAvailable(path);
  const temporary = `${path}.makefx-${id()}.tmp`;
  let published = false;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    await link(temporary, path);
    published = true;
    await unlink(temporary);
  } finally {
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function alignmentText(parsed: ParsedArgs): Promise<string | undefined> {
  const path = option(parsed, 'input');
  const inline = parsed.positionals[1];
  if (path && inline !== undefined) throw new CliUsageError('Use inline text or --input, not both.');
  if (parsed.positionals.length > 2) throw new CliUsageError(audioCommandUsage('audio align'));
  if (!path) return inline;
  const value = await readFile(resolve(path), 'utf8');
  if (Array.from(value).length > 675_000) throw new Error('Alignment input exceeds 675,000 characters.');
  return value;
}

export async function handleAudioCommand(
  command: AudioCommand,
  parsed: ParsedArgs,
  dependencies: Dependencies = defaults,
): Promise<void> {
  if (parsed.positionals.length < 1) throw new CliUsageError(audioCommandUsage(command));
  const asset = parsed.positionals[0];
  if (!asset) throw new CliUsageError(audioCommandUsage(command));
  const space = required(parsed, 'space', command);
  const client = await dependencies.client(parsed);
  if (command === 'audio align') {
    rejectOptions(parsed, command, ['space', 'input', 'request-id', 'wait']);
    const text = await alignmentText(parsed);
    let result = await client.call('align_audio', {
      space_id: space,
      asset_id: asset,
      request_id: option(parsed, 'request-id') ?? dependencies.id(),
      ...(text === undefined ? {} : { text }),
    });
    const admitted = record(result.alignment_job);
    if (parsed.options.wait === 'true' && typeof admitted?.alignment_job_id === 'string') {
      while (admitted.status === 'queued' || admitted.status === 'running') {
        result = await client.call('get_audio_word_timings', {
          space_id: space,
          asset_id: asset,
          alignment_job_id: admitted.alignment_job_id,
          wait_seconds: 60,
        });
        const current = record(result.alignment_job);
        if (!current || current.status === 'completed' || current.status === 'failed') break;
        admitted.status = current.status;
      }
    }
    if (parsed.options.json === 'true') {
      dependencies.write(JSON.stringify(result, null, 2));
      return;
    }
    const job = record(result.alignment_job) ?? admitted ?? {};
    const credits = job.charged_credits ?? job.estimated_credits;
    dependencies.write(
      [
        typeof job.alignment_job_id === 'string' ? `Alignment ${job.alignment_job_id}` : undefined,
        typeof job.status === 'string' ? job.status : undefined,
        typeof credits === 'number' ? `${credits} credits` : undefined,
        typeof result.web_url === 'string' ? result.web_url : undefined,
      ]
        .filter((value): value is string => value !== undefined)
        .join(' · '),
    );
    return;
  }

  rejectOptions(parsed, command, ['space', 'out']);
  if (parsed.positionals.length !== 1) throw new CliUsageError(audioCommandUsage(command));
  const result = await client.call('get_audio_word_timings', {
    space_id: space,
    asset_id: asset,
    wait_seconds: 0,
  });
  if (!result.word_timings) throw new Error('No word timings are available.');
  const out = option(parsed, 'out');
  if (out) {
    const destination = resolve(out);
    await publishJson(destination, result.word_timings, dependencies.id);
    dependencies.write(parsed.options.json === 'true' ? JSON.stringify(result, null, 2) : destination);
  } else {
    dependencies.write(JSON.stringify(result.word_timings, null, 2));
  }
}
