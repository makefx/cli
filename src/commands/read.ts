import type { ParsedArgs } from '../lib/types.ts';
import { authenticatedToolClient, type ToolClient } from '../lib/tool-client.ts';
import { CliUsageError } from '../lib/errors.ts';

type CommandDependencies = {
  client: (parsed: ParsedArgs) => Promise<ToolClient>;
  write: (text: string) => void;
};

const defaults: CommandDependencies = {
  client: authenticatedToolClient,
  write: (text) => process.stdout.write(`${text}\n`),
};

const GLOBAL_OPTIONS = ['env', 'local', 'json'];

const USAGE = {
  account: 'account [--account ID] [--json]',
  spaces: 'spaces [--account ID] [--query TEXT] [--limit 1..100] [--json]',
  'space create': 'space create --name NAME [--account ID] [--id ID] [--json]',
  'space get': 'space get --space ACCOUNT/SPACE [--starred-only] [--json]',
  'space delete': 'space delete --space ACCOUNT/SPACE [--json]',
  models:
    'models [--space ACCOUNT/SPACE] [--kind image|video|audio] [--family provider|internal|browser] [--json]',
  'profile get': 'profile get [--json]',
  health: 'health [--json]',
  estimate:
    'estimate --kind KIND --model MODEL [--space ACCOUNT/SPACE] [--prompt TEXT] [--ref ASSET:SLOT]... [--param NAME=VALUE]... [--count 1..8] [--from-asset ASSET] [--recipe-mode current|exact] [--json]',
  'asset get': 'asset get --space ACCOUNT/SPACE --asset ID [--wait-seconds 0..60] [--json]',
} as const;

export type DataCommand = keyof typeof USAGE;

export function commandUsage(command: DataCommand): string {
  return `Usage: makefx ${USAGE[command]}`;
}

function required(parsed: ParsedArgs, name: string, command: DataCommand): string {
  const value = parsed.options[name];
  if (!value || value === 'true') throw new CliUsageError(`${command} requires --${name} <value>.`);
  return value;
}

function rejectUnexpected(parsed: ParsedArgs, command: DataCommand, options: string[]): void {
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(
      `${command} does not accept "${parsed.positionals[0]}". ${commandUsage(command)}`,
    );
  }
  const allowed = new Set([...GLOBAL_OPTIONS, ...options]);
  const unexpected = Object.keys(parsed.options).find((option) => !allowed.has(option));
  if (unexpected) throw new CliUsageError(`Unknown option --${unexpected}. ${commandUsage(command)}`);
}

function optional(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === 'true') throw new CliUsageError(`--${name} requires a value.`);
  return value;
}

function integerOption(parsed: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const value = optional(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CliUsageError(`--${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function pair(value: string): { asset_id: string; slot: string } {
  const at = value.lastIndexOf(':');
  if (at <= 0 || at === value.length - 1) throw new CliUsageError('--ref must be written as asset:slot.');
  return { asset_id: value.slice(0, at), slot: value.slice(at + 1) };
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

function mediaKind(parsed: ParsedArgs, command: DataCommand): string {
  const kind = required(parsed, 'kind', command);
  if (!['image', 'video', 'audio'].includes(kind)) {
    throw new CliUsageError('--kind must be image, video, or audio.');
  }
  return kind;
}

export function dataToolCall(
  command: DataCommand,
  parsed: ParsedArgs,
): { name: string; args: Record<string, unknown> } {
  switch (command) {
    case 'account': {
      rejectUnexpected(parsed, command, ['account']);
      const account = optional(parsed, 'account');
      return { name: 'get_account', args: account ? { account_id: account } : {} };
    }
    case 'spaces': {
      rejectUnexpected(parsed, command, ['account', 'query', 'limit']);
      const account = optional(parsed, 'account');
      const query = optional(parsed, 'query');
      const limit = integerOption(parsed, 'limit', 1, 100);
      return {
        name: 'list_spaces',
        args: {
          ...(account ? { account_id: account } : {}),
          ...(query ? { query } : {}),
          ...(limit ? { limit } : {}),
        },
      };
    }
    case 'space create': {
      rejectUnexpected(parsed, command, ['name', 'account', 'id']);
      const account = optional(parsed, 'account');
      const id = optional(parsed, 'id');
      return {
        name: 'create_space',
        args: {
          name: required(parsed, 'name', command),
          ...(account ? { account_id: account } : {}),
          ...(id ? { space_id: id } : {}),
        },
      };
    }
    case 'space get':
      rejectUnexpected(parsed, command, ['space', 'starred-only']);
      return {
        name: 'get_space',
        args: {
          space_id: required(parsed, 'space', command),
          starred_only: parsed.options['starred-only'] === 'true',
        },
      };
    case 'space delete':
      rejectUnexpected(parsed, command, ['space']);
      return { name: 'delete_space', args: { space_id: required(parsed, 'space', command) } };
    case 'models': {
      rejectUnexpected(parsed, command, ['space', 'kind', 'family']);
      const space = optional(parsed, 'space');
      const kind = optional(parsed, 'kind');
      const family = optional(parsed, 'family');
      if (kind && !['image', 'video', 'audio'].includes(kind)) {
        throw new CliUsageError('--kind must be image, video, or audio.');
      }
      if (family && !['provider', 'internal', 'browser'].includes(family)) {
        throw new CliUsageError('--family must be provider, internal, or browser.');
      }
      return {
        name: 'list_models',
        args: {
          ...(space ? { space_id: space } : {}),
          ...(kind ? { kind } : {}),
          ...(family ? { family } : {}),
        },
      };
    }
    case 'profile get':
      rejectUnexpected(parsed, command, []);
      return { name: 'get_profile', args: {} };
    case 'health':
      rejectUnexpected(parsed, command, []);
      return { name: 'health_check', args: {} };
    case 'estimate': {
      rejectUnexpected(parsed, command, [
        'space',
        'kind',
        'model',
        'prompt',
        'ref',
        'param',
        'count',
        'from-asset',
        'recipe-mode',
      ]);
      const space = optional(parsed, 'space');
      const count = integerOption(parsed, 'count', 1, 8);
      const recipeMode = parsed.options['recipe-mode'];
      if (recipeMode !== undefined && recipeMode !== 'current' && recipeMode !== 'exact') {
        throw new CliUsageError('--recipe-mode must be current or exact.');
      }
      const fromAssetId = parsed.options['from-asset'];
      if (recipeMode === 'exact' && (!fromAssetId || fromAssetId === 'true')) {
        throw new CliUsageError('--recipe-mode exact requires --from-asset <asset>.');
      }
      return {
        name: 'estimate_credits',
        args: {
          ...(space ? { space_id: space } : {}),
          kind: mediaKind(parsed, command),
          model: required(parsed, 'model', command),
          prompt: optional(parsed, 'prompt') ?? '',
          references: (parsed.values.ref ?? []).map(pair),
          params: Object.fromEntries((parsed.values.param ?? []).map(parameter)),
          count: count ?? 1,
          ...(recipeMode === undefined ? {} : { recipe_mode: recipeMode }),
          ...(fromAssetId && fromAssetId !== 'true' ? { from_asset_id: fromAssetId } : {}),
        },
      };
    }
    case 'asset get':
      rejectUnexpected(parsed, command, ['space', 'asset', 'wait-seconds']);
      return {
        name: 'get_asset',
        args: {
          space_id: required(parsed, 'space', command),
          asset_id: required(parsed, 'asset', command),
          wait_seconds: integerOption(parsed, 'wait-seconds', 0, 60) ?? 0,
        },
      };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function humanOutput(command: DataCommand, result: Record<string, unknown>): string[] {
  if (command === 'account') {
    const topup = typeof result.topup_url === 'string' ? [`Top up: ${result.topup_url}`] : [];
    return [
      `${String(result.account_id)} ${String(result.balance_credits)} credits (${String(result.held_credits)} held)`,
      ...topup,
    ];
  }
  if (command === 'spaces') {
    const spaces = Array.isArray(result.spaces) ? result.spaces : [];
    if (spaces.length === 0) return ['No spaces.'];
    return spaces.map((value) => {
      const space = record(value) ?? {};
      return [space.space_id, space.web_url].filter((item) => typeof item === 'string').join(' ');
    });
  }
  if (command === 'models') {
    const models = Array.isArray(result.models) ? result.models : [];
    return models
      .map((value) => record(value) ?? {})
      .filter((model) => model.hidden !== true)
      .map((model) =>
        [model.label, model.provider_model, model.provider, model.provider_model_kind, model.id]
          .filter((item) => typeof item === 'string')
          .join(' · '),
      );
  }
  if (command === 'profile get') {
    return [
      [result.id, result.email, result.name]
        .filter((item) => typeof item === 'string' && item.length > 0)
        .join(' · '),
    ];
  }
  if (command === 'health') {
    return [
      [result.status, result.environment]
        .filter((item) => typeof item === 'string' && item.length > 0)
        .join(' · '),
    ];
  }
  if (command === 'estimate') {
    const topup = typeof result.topup_url === 'string' ? [`Top up: ${result.topup_url}`] : [];
    return [`${String(result.credits)} credits (${String(result.balance_after_credits)} after)`, ...topup];
  }
  if (command === 'space create') {
    const space = record(result.space) ?? {};
    return [[space.space_id, space.web_url].filter((item) => typeof item === 'string').join(' ')];
  }
  if (command === 'space get') {
    const space = record(result.space) ?? {};
    const assets = Array.isArray(result.assets) ? result.assets.length : 0;
    const links = Array.isArray(result.links) ? result.links.length : 0;
    return [
      [space.space_id, result.web_url].filter((item) => typeof item === 'string').join(' '),
      `${assets} assets, ${links} links`,
    ];
  }
  if (command === 'space delete') return [`Deleted ${String(result.space_id)} ${String(result.web_url)}`];
  const asset = record(result.asset) ?? {};
  return [
    [asset.asset_id, asset.status, result.web_url].filter((item) => typeof item === 'string').join(' '),
  ];
}

export async function handleDataCommand(
  command: DataCommand,
  parsed: ParsedArgs,
  dependencies: CommandDependencies = defaults,
): Promise<void> {
  const call = dataToolCall(command, parsed);
  const client = await dependencies.client(parsed);
  const result = await client.call(call.name, call.args);
  if (parsed.options.json === 'true') {
    dependencies.write(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of humanOutput(command, result)) dependencies.write(line);
}
