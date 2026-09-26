import { randomUUID } from 'node:crypto';
import process from 'node:process';
import type { ParsedArgs } from '../lib/types.ts';
import { authenticatedToolClient, type ToolClient } from '../lib/tool-client.ts';
import { CliUsageError } from '../lib/errors.ts';
import { assertJsonSchema, validateJsonSchema, type JsonSchema } from '../lib/json-schema.ts';

type CreateDependencies = {
  client: (parsed: ParsedArgs) => Promise<ToolClient>;
  write: (text: string) => void;
  id: () => string;
};

const defaults: CreateDependencies = {
  client: authenticatedToolClient,
  write: (text) => process.stdout.write(`${text}\n`),
  id: randomUUID,
};

const USAGE =
  'Usage: makefx create --space ACCOUNT/SPACE --kind image|video|audio --model MODEL [--prompt TEXT] [--ref ASSET:SLOT]... [--param NAME=VALUE]... [--count 1..8] [--name TEXT] [--seed INTEGER] [--position JSON] [--tags JSON] [--note TEXT] [--from-asset ASSET] [--recipe-mode current|exact] [--request-id ID] [--wait] [--json]';
const CREATE_OPTIONS = new Set([
  'env',
  'local',
  'json',
  'help',
  'space',
  'kind',
  'model',
  'prompt',
  'ref',
  'param',
  'count',
  'name',
  'seed',
  'position',
  'tags',
  'note',
  'from-asset',
  'recipe-mode',
  'request-id',
  'wait',
]);

type PreparedCreate = {
  spaceId: string;
  kind: string;
  model: string;
  prompt: string;
  references: Array<{ asset_id: string; slot: string; order: number }>;
  params: Record<string, unknown>;
  count: number;
  recipeMode?: string;
  fromAssetId?: string;
  name?: string;
  seed?: number;
  position?: { x: number; y: number };
  tags: string[];
  note?: string;
  requestId?: string;
};

type LiveModel = {
  id: string;
  kind: 'image' | 'video' | 'audio';
  availability: 'available' | 'preview' | 'unavailable';
  hidden: boolean;
  paramsSchema: JsonSchema;
  promptMaxChars?: number;
};

function required(parsed: ParsedArgs, name: string): string {
  const value = parsed.options[name];
  if (!value || value === 'true') throw new CliUsageError(`create requires --${name} <value>.`);
  return value;
}

function optional(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === 'true') throw new CliUsageError(`--${name} requires a value.`);
  return value;
}

function rejectUnexpected(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`create does not accept "${parsed.positionals[0]}". ${USAGE}`);
  }
  const unexpected = Object.keys(parsed.options).find((name) => !CREATE_OPTIONS.has(name));
  if (unexpected) throw new CliUsageError(`Unknown option --${unexpected}. ${USAGE}`);
}

function rejectFlagValues(parsed: ParsedArgs): void {
  for (const name of ['local', 'json', 'help', 'wait']) {
    const value = parsed.options[name];
    if (value !== undefined && value !== 'true') {
      throw new CliUsageError(`--${name} does not accept a value. ${USAGE}`);
    }
  }
}

function pair(value: string, option: string): [string, string] {
  const at = value.lastIndexOf(':');
  if (at <= 0 || at === value.length - 1) throw new CliUsageError(`${option} must be written as value:name.`);
  return [value.slice(0, at), value.slice(at + 1)];
}

function parameter(value: string): [string, unknown] {
  const at = value.indexOf('=');
  if (at <= 0) throw new CliUsageError('--param must be written as name=value.');
  return [value.slice(0, at), scalar(value.slice(at + 1))];
}

function integer(parsed: ParsedArgs, name: string): number | undefined {
  const value = optional(parsed, name);
  if (value === undefined) return undefined;
  if (value.trim() === '') throw new CliUsageError(`--${name} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new CliUsageError(`--${name} must be an integer.`);
  return number;
}

function json(parsed: ParsedArgs, name: string): unknown {
  const value = optional(parsed, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliUsageError(`--${name} must be valid JSON.`);
  }
}

function positionOption(parsed: ParsedArgs): { x: number; y: number } | undefined {
  const value = json(parsed, 'position');
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'x' && key !== 'y') ||
    typeof (value as { x?: unknown }).x !== 'number' ||
    !Number.isFinite((value as { x: number }).x) ||
    typeof (value as { y?: unknown }).y !== 'number' ||
    !Number.isFinite((value as { y: number }).y)
  ) {
    throw new CliUsageError('--position must be a JSON object with finite numeric x and y.');
  }
  return value as { x: number; y: number };
}

function tagsOption(parsed: ParsedArgs): string[] {
  const value = json(parsed, 'tags');
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    !value.every((tag) => typeof tag === 'string' && tag.length <= 40)
  ) {
    throw new CliUsageError('--tags must be a JSON array of at most 16 strings up to 40 characters.');
  }
  return value;
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

function prepareCreate(parsed: ParsedArgs): PreparedCreate {
  rejectUnexpected(parsed);
  rejectFlagValues(parsed);
  optional(parsed, 'env');
  const kind = required(parsed, 'kind');
  if (!['image', 'video', 'audio'].includes(kind)) {
    throw new CliUsageError('--kind must be image, video, or audio.');
  }
  const model = required(parsed, 'model');
  const references = (parsed.values.ref ?? []).map((value, order) => {
    const [asset_id, slot] = pair(value, '--ref');
    if (asset_id.length > 64 || slot.length > 64) {
      throw new CliUsageError('--ref asset and slot must each be at most 64 characters.');
    }
    return { asset_id, slot, order };
  });
  if (references.length > 64) throw new CliUsageError('create accepts at most 64 --ref values.');
  const count = parsed.options.count === undefined ? 1 : Number(parsed.options.count);
  if (!Number.isSafeInteger(count) || count < 1 || count > 8)
    throw new CliUsageError('--count must be an integer from 1 to 8.');
  const recipeMode = optional(parsed, 'recipe-mode');
  if (recipeMode !== undefined && recipeMode !== 'current' && recipeMode !== 'exact') {
    throw new CliUsageError('--recipe-mode must be current or exact.');
  }
  const fromAssetId = optional(parsed, 'from-asset');
  if (recipeMode === 'exact' && !fromAssetId) {
    throw new CliUsageError('--recipe-mode exact requires --from-asset <asset>.');
  }
  const name = optional(parsed, 'name');
  if (name !== undefined && (!name.trim() || name.length > 120)) {
    throw new CliUsageError('--name must be 1 to 120 characters and not blank.');
  }
  const seed = integer(parsed, 'seed');
  const position = positionOption(parsed);
  const tags = tagsOption(parsed);
  const note = optional(parsed, 'note');
  if (note !== undefined && note.length > 4000) {
    throw new CliUsageError('--note must be at most 4000 characters.');
  }
  const requestId = optional(parsed, 'request-id');
  if (requestId !== undefined && requestId.length > 64) {
    throw new CliUsageError('--request-id must be at most 64 characters.');
  }
  const prompt = optional(parsed, 'prompt') ?? '';
  if (Array.from(prompt).length > 8000) throw new CliUsageError('--prompt must be at most 8000 characters.');
  return {
    spaceId: required(parsed, 'space'),
    kind,
    model,
    prompt,
    references,
    params: Object.fromEntries((parsed.values.param ?? []).map(parameter)),
    count,
    ...(recipeMode === undefined ? {} : { recipeMode }),
    ...(fromAssetId && fromAssetId !== 'true' ? { fromAssetId } : {}),
    ...(name ? { name } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(position !== undefined ? { position } : {}),
    tags,
    ...(note !== undefined ? { note } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function catalogModels(document: Record<string, unknown>): LiveModel[] {
  if (
    typeof document.credit_eur !== 'number' ||
    !Number.isFinite(document.credit_eur) ||
    document.credit_eur <= 0
  ) {
    throw new Error('list_models returned a malformed catalog: credit_eur must be a positive number.');
  }
  if (!Array.isArray(document.actions)) {
    throw new Error('list_models returned a malformed catalog: actions must be an array.');
  }
  if (!Array.isArray(document.models))
    throw new Error('list_models returned a malformed catalog: models must be an array.');
  const ids = new Set<string>();
  return document.models.map((value, index) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`list_models returned a malformed catalog: models[${index}] must be an object.`);
    }
    const model = value as Record<string, unknown>;
    if (typeof model.id !== 'string' || model.id.length === 0) {
      throw new Error(`list_models returned a malformed catalog: models[${index}].id must be a string.`);
    }
    if (ids.has(model.id))
      throw new Error(`list_models returned a malformed catalog: duplicate model "${model.id}".`);
    ids.add(model.id);
    if (!['image', 'video', 'audio'].includes(String(model.kind))) {
      throw new Error(`list_models returned a malformed catalog: model "${model.id}" has an invalid kind.`);
    }
    if (!['available', 'preview', 'unavailable'].includes(String(model.availability))) {
      throw new Error(
        `list_models returned a malformed catalog: model "${model.id}" has invalid availability.`,
      );
    }
    if (typeof model.hidden !== 'boolean') {
      throw new Error(`list_models returned a malformed catalog: model "${model.id}" has no hidden flag.`);
    }
    try {
      assertJsonSchema(model.params_schema, `model "${model.id}" params_schema`);
      if (model.params_schema.type !== 'object') {
        throw new Error(`model "${model.id}" params_schema.type must be object.`);
      }
    } catch (error) {
      throw new Error(
        `list_models returned a malformed catalog: ${error instanceof Error ? error.message : 'invalid params_schema.'}`,
      );
    }
    const promptMaxChars = model.prompt_max_chars;
    if (
      promptMaxChars !== undefined &&
      (typeof promptMaxChars !== 'number' || !Number.isSafeInteger(promptMaxChars) || promptMaxChars < 1)
    ) {
      throw new Error(
        `list_models returned a malformed catalog: model "${model.id}" prompt_max_chars must be a positive integer.`,
      );
    }
    return {
      id: model.id,
      kind: model.kind as LiveModel['kind'],
      availability: model.availability as LiveModel['availability'],
      hidden: model.hidden,
      paramsSchema: model.params_schema,
      ...(promptMaxChars === undefined ? {} : { promptMaxChars }),
    };
  });
}

function createToolArguments(
  prepared: PreparedCreate,
  entry: LiveModel,
  requestId: string,
): Record<string, unknown> {
  if (entry.kind !== prepared.kind) {
    throw new CliUsageError(`Model "${prepared.model}" creates ${entry.kind} assets, not ${prepared.kind}.`);
  }
  if (entry.availability === 'unavailable' && prepared.recipeMode !== 'exact') {
    throw new CliUsageError(
      `Model "${prepared.model}" is unavailable. Run models --space ${prepared.spaceId} to list the catalog.`,
    );
  }
  // An exact replay is judged by the terms it recorded, which the service reads.
  if (
    entry.promptMaxChars !== undefined &&
    prepared.recipeMode !== 'exact' &&
    Array.from(prepared.prompt).length > entry.promptMaxChars
  ) {
    throw new CliUsageError(
      `--prompt must be at most ${entry.promptMaxChars} characters for model "${prepared.model}".`,
    );
  }
  const validation = validateJsonSchema(entry.paramsSchema, prepared.params);
  if (!validation.ok) {
    const field = validation.issue.field.replace(/^params\.?/, '') || 'params';
    throw new CliUsageError(`Invalid --param ${field}: ${validation.issue.message}`);
  }
  return {
    space_id: prepared.spaceId,
    kind: prepared.kind,
    model: prepared.model,
    prompt: prepared.prompt,
    references: prepared.references,
    params: validation.value,
    count: prepared.count,
    ...(prepared.recipeMode === undefined ? {} : { recipe_mode: prepared.recipeMode }),
    ...(prepared.fromAssetId ? { from_asset_id: prepared.fromAssetId } : {}),
    ...(prepared.name ? { name: prepared.name } : {}),
    ...(prepared.seed !== undefined ? { seed: prepared.seed } : {}),
    ...(prepared.position !== undefined ? { position: prepared.position } : {}),
    tags: prepared.tags,
    ...(prepared.note !== undefined ? { note: prepared.note } : {}),
    request_id: prepared.requestId ?? requestId,
  };
}

export async function handleCreate(
  parsed: ParsedArgs,
  dependencies: CreateDependencies = defaults,
): Promise<void> {
  const prepared = prepareCreate(parsed);
  const client = await dependencies.client(parsed);
  const catalog = await client.call('list_models', { space_id: prepared.spaceId });
  const entry = catalogModels(catalog).find(({ id, hidden }) => id === prepared.model && !hidden);
  if (!entry) {
    throw new CliUsageError(
      `Unknown model "${prepared.model}". Run models --space ${prepared.spaceId} to list the catalog.`,
    );
  }
  const args = createToolArguments(prepared, entry, dependencies.id());
  const created = await client.call('create_asset', args);
  let assets = Array.isArray(created.assets) ? (created.assets as Array<Record<string, unknown>>) : [];
  if (parsed.options.wait === 'true' && !assets.some(({ renders_in }) => renders_in === 'browser')) {
    const spaceId = prepared.spaceId;
    assets = await Promise.all(
      assets.map(async (asset) => {
        const assetId = asset.asset_id;
        if (typeof assetId !== 'string') return asset;
        while (true) {
          const result = await client.call('get_asset', {
            space_id: spaceId,
            asset_id: assetId,
            wait_seconds: 60,
          });
          const current = result.asset as Record<string, unknown> | undefined;
          if (current?.status === 'ready' || current?.status === 'failed') {
            return current ? { ...asset, ...current } : asset;
          }
        }
      }),
    );
    created.assets = assets;
    const failed = assets.filter((asset) => asset.status === 'failed');
    if (failed.length > 0) {
      if (parsed.options.json === 'true') {
        dependencies.write(JSON.stringify(created, null, 2));
        process.exitCode = 1;
        return;
      }
      const messages = failed.map((asset) => {
        const error = asset.error as { message?: string } | null | undefined;
        return error?.message ?? `Asset ${String(asset.asset_id)} failed.`;
      });
      throw new Error(messages.join('\n'));
    }
  }
  if (parsed.options.json === 'true') {
    dependencies.write(JSON.stringify(created, null, 2));
    return;
  }
  for (const asset of assets) {
    dependencies.write(
      [asset.asset_id, asset.web_url].filter((value) => typeof value === 'string').join(' '),
    );
  }
}
