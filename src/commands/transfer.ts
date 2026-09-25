import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { ParsedArgs } from '../lib/types.ts';
import { authenticatedToolClient, type ToolClient } from '../lib/tool-client.ts';
import { CliUsageError } from '../lib/errors.ts';

type TransferDependencies = {
  client: (parsed: ParsedArgs) => Promise<ToolClient>;
  fetch: typeof fetch;
  write: (text: string) => void;
  id: () => string;
};

const defaults: TransferDependencies = {
  client: authenticatedToolClient,
  fetch,
  write: (text) => process.stdout.write(`${text}\n`),
  id: randomUUID,
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'video/mp4': '.mp4',
};

const GLOBAL_OPTIONS = ['env', 'local', 'json'];

const USAGE = {
  upload:
    'upload --space ACCOUNT/SPACE --kind image|video|audio --file PATH [--mime TYPE] [--name TEXT] [--provider NAME] [--model ORIGIN] [--prompt TEXT] [--param NAME=VALUE]... [--ref ASSET:SLOT]... [--external-run-id ID] [--position JSON] [--tags JSON] [--request-id ID] [--json]',
  download: 'download ASSET --space ACCOUNT/SPACE [--out PATH] [--json]',
} as const;

export type TransferCommand = keyof typeof USAGE;

export function transferCommandUsage(command: TransferCommand): string {
  return `Usage: makefx ${USAGE[command]}`;
}

function required(parsed: ParsedArgs, name: string, command: TransferCommand): string {
  const value = parsed.options[name];
  if (!value || value === 'true') throw new CliUsageError(`${command} requires --${name} <value>.`);
  return value;
}

function optional(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === 'true') throw new CliUsageError(`--${name} requires a value.`);
  return value;
}

function rejectUnexpected(parsed: ParsedArgs, command: TransferCommand, options: string[]): void {
  const allowed = new Set([...GLOBAL_OPTIONS, ...options]);
  const unexpected = Object.keys(parsed.options).find((option) => !allowed.has(option));
  if (unexpected) throw new CliUsageError(`Unknown option --${unexpected}. ${transferCommandUsage(command)}`);
}

function scalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new CliUsageError('--param arrays and objects must be valid JSON.');
    }
  }
  return value;
}

function parameter(value: string): [string, unknown] {
  const at = value.indexOf('=');
  if (at <= 0) throw new CliUsageError('--param must be written as name=value.');
  return [value.slice(0, at), scalar(value.slice(at + 1))];
}

function objectOption(parsed: ParsedArgs, name: string): Record<string, unknown> | undefined {
  const value = optional(parsed, name);
  if (value === undefined) return undefined;
  try {
    const parsedValue = JSON.parse(value) as unknown;
    if (parsedValue === null || typeof parsedValue !== 'object' || Array.isArray(parsedValue))
      throw new Error();
    return parsedValue as Record<string, unknown>;
  } catch {
    throw new CliUsageError(`--${name} must be a JSON object.`);
  }
}

function tagsOption(parsed: ParsedArgs): string[] | undefined {
  const value = optional(parsed, 'tags');
  if (value === undefined) return undefined;
  try {
    const tags = JSON.parse(value) as unknown;
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) throw new Error();
    return tags;
  } catch {
    throw new CliUsageError('--tags must be a JSON array of strings.');
  }
}

function mediaKind(parsed: ParsedArgs): string {
  const kind = required(parsed, 'kind', 'upload');
  if (!['image', 'video', 'audio'].includes(kind)) {
    throw new CliUsageError('--kind must be image, video, or audio.');
  }
  return kind;
}

function uploadMime(parsed: ParsedArgs, path: string): string {
  const explicit = optional(parsed, 'mime');
  if (explicit) return explicit;
  const inferred = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (!inferred) {
    const supported = Object.keys(MIME_BY_EXTENSION).sort().join(', ');
    throw new CliUsageError(
      `Cannot infer media type from --file; supported uploads are ${supported} — pass --mime <type> to override.`,
    );
  }
  return inferred;
}

function declaredRecipe(parsed: ParsedArgs): Record<string, unknown> | undefined {
  const recipeOptions = ['provider', 'model', 'prompt', 'external-run-id'];
  const hasRecipe =
    recipeOptions.some((name) => parsed.options[name] !== undefined) ||
    (parsed.values.param?.length ?? 0) > 0 ||
    (parsed.values.ref?.length ?? 0) > 0;
  if (!hasRecipe) return undefined;
  const provider = optional(parsed, 'provider') ?? 'external';
  if (provider !== 'external') throw new CliUsageError('--provider must be external.');
  const model = required(parsed, 'model', 'upload');
  const references = (parsed.values.ref ?? []).map((value, order) => {
    const at = value.lastIndexOf(':');
    if (at <= 0 || at === value.length - 1) {
      throw new CliUsageError('--ref must be written as asset:slot.');
    }
    return { asset_id: value.slice(0, at), slot: value.slice(at + 1), order };
  });
  const externalRunId = optional(parsed, 'external-run-id');
  return {
    provider: 'external',
    model,
    prompt: optional(parsed, 'prompt') ?? '',
    params: Object.fromEntries((parsed.values.param ?? []).map(parameter)),
    references,
    ...(externalRunId !== undefined ? { external_run_id: externalRunId } : {}),
  };
}

export function uploadToolArguments(
  parsed: ParsedArgs,
  file: { path: string; size: number },
): Record<string, unknown> {
  rejectUnexpected(parsed, 'upload', [
    'space',
    'kind',
    'file',
    'mime',
    'name',
    'provider',
    'model',
    'prompt',
    'param',
    'ref',
    'external-run-id',
    'position',
    'tags',
    'request-id',
  ]);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(
      `upload does not accept "${parsed.positionals[0]}". ${transferCommandUsage('upload')}`,
    );
  }
  const name = optional(parsed, 'name');
  const recipe = declaredRecipe(parsed);
  const position = objectOption(parsed, 'position');
  const tags = tagsOption(parsed);
  const requestId = optional(parsed, 'request-id');
  return {
    space_id: required(parsed, 'space', 'upload'),
    kind: mediaKind(parsed),
    filename: basename(file.path),
    mime: uploadMime(parsed, file.path),
    size_bytes: file.size,
    ...(name !== undefined ? { name } : {}),
    ...(recipe !== undefined ? { recipe } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function signedUpload(result: Record<string, unknown>): {
  url: string;
  headers: Record<string, string>;
} {
  const headers = record(result.headers);
  if (
    result.method !== 'PUT' ||
    typeof result.upload_url !== 'string' ||
    !headers ||
    !Object.values(headers).every((value) => typeof value === 'string')
  ) {
    throw new Error('upload_asset returned an unusable signed upload.');
  }
  return { url: result.upload_url, headers: headers as Record<string, string> };
}

async function uploadFile(
  handle: FileHandle,
  size: number,
  signed: { url: string; headers: Record<string, string> },
  fetchImpl: typeof fetch,
): Promise<void> {
  const source = handle.createReadStream();
  let bytes = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
  source.once('error', (error) => counted.destroy(error));
  source.pipe(counted);
  try {
    const request: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers: signed.headers,
      body: counted as unknown as BodyInit,
      duplex: 'half',
    };
    const response = await fetchImpl(signed.url, request);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Upload failed with HTTP ${response.status}.`);
    }
    await finished(source);
    if (bytes !== size) throw new Error(`Upload ended after ${bytes} of ${size} bytes.`);
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    source.destroy();
    counted.destroy();
    throw error;
  }
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

function expectedLength(response: Response, asset: Record<string, unknown>): number | undefined {
  const header = response.headers.get('content-length');
  if (header !== null) {
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error('Download returned an invalid Content-Length.');
    return length;
  }
  const media = record(asset.media);
  return typeof media?.size_bytes === 'number' ? media.size_bytes : undefined;
}

async function downloadFile(
  url: string,
  destination: string,
  asset: Record<string, unknown>,
  fetchImpl: typeof fetch,
  id: () => string,
): Promise<void> {
  await destinationAvailable(destination);
  const temporary = `${destination}.makefx-${id()}.tmp`;
  let published = false;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Download failed with HTTP ${response.status}.`);
    }
    if (!response.body) throw new Error('Download returned no media body.');
    const expected = expectedLength(response, asset);
    let bytes = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(null, chunk);
      },
    });
    await pipeline(Readable.from(response.body), counted, createWriteStream(temporary, { flags: 'wx' }));
    if (expected !== undefined && bytes !== expected) {
      throw new Error(`Download ended after ${bytes} of ${expected} bytes.`);
    }
    await link(temporary, destination);
    published = true;
    await unlink(temporary);
  } finally {
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}

function downloadDestination(parsed: ParsedArgs, asset: Record<string, unknown>): string {
  const out = optional(parsed, 'out');
  if (out) return resolve(out);
  const assetId = typeof asset.asset_id === 'string' ? asset.asset_id : parsed.positionals[0];
  const media = record(asset.media);
  const extension = typeof media?.mime === 'string' ? (EXTENSION_BY_MIME[media.mime] ?? '') : '';
  return resolve(`${assetId}${extension}`);
}

export async function handleTransferCommand(
  command: TransferCommand,
  parsed: ParsedArgs,
  dependencies: TransferDependencies = defaults,
): Promise<void> {
  if (command === 'upload') {
    const path = resolve(required(parsed, 'file', command));
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
      const args = uploadToolArguments(parsed, { path, size: stat.size });
      const client = await dependencies.client(parsed);
      const result = await client.call('upload_asset', args);
      await uploadFile(handle, stat.size, signedUpload(result), dependencies.fetch);
      dependencies.write(
        parsed.options.json === 'true'
          ? JSON.stringify(result, null, 2)
          : [result.asset_id, result.web_url].filter((value) => typeof value === 'string').join(' '),
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
    return;
  }

  rejectUnexpected(parsed, command, ['space', 'out']);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(`download requires one asset id. ${transferCommandUsage(command)}`);
  }
  const client = await dependencies.client(parsed);
  const result = await client.call('get_asset', {
    space_id: required(parsed, 'space', command),
    asset_id: parsed.positionals[0],
    wait_seconds: 0,
  });
  const asset = record(result.asset);
  if (!asset || asset.status !== 'ready' || typeof asset.media_url !== 'string') {
    throw new Error(`Asset ${parsed.positionals[0]} is not ready for download.`);
  }
  const destination = downloadDestination(parsed, asset);
  await downloadFile(asset.media_url, destination, asset, dependencies.fetch, dependencies.id);
  dependencies.write(
    parsed.options.json === 'true'
      ? JSON.stringify(result, null, 2)
      : [asset.asset_id, result.web_url ?? asset.web_url, destination]
          .filter((value) => typeof value === 'string')
          .join(' '),
  );
}
