import { randomUUID } from 'node:crypto';
import type { ParsedArgs } from '../lib/types.ts';
import { authenticatedToolClient, type ToolClient } from '../lib/tool-client.ts';
import { CliUsageError } from '../lib/errors.ts';

type MutationDependencies = {
  client: (parsed: ParsedArgs) => Promise<ToolClient>;
  write: (text: string) => void;
  id: () => string;
};

const defaults: MutationDependencies = {
  client: authenticatedToolClient,
  write: (text) => process.stdout.write(`${text}\n`),
  id: randomUUID,
};

const GLOBAL_OPTIONS = ['env', 'local', 'json'];

const USAGE = {
  'voices sync': 'voices sync --account ACCOUNT [--json]',
  'profile update': 'profile update --name TEXT [--json]',
  'space update': 'space update --space ACCOUNT/SPACE --name TEXT [--json]',
  'asset update':
    'asset update --space ACCOUNT/SPACE --asset ID [--name TEXT] [--note TEXT|null] [--traits TEXT|null] [--tags JSON] [--starred true|false] [--position JSON] [--recipe JSON] [--json]',
  'asset delete': 'asset delete --space ACCOUNT/SPACE --asset ID [--json]',
  describe: 'describe --space ACCOUNT/SPACE --asset ID [--request-id ID] [--json]',
  link: 'link --space ACCOUNT/SPACE --from ASSET --to ASSET [--label TEXT] [--json]',
  unlink: 'unlink --space ACCOUNT/SPACE (--link ID | --from ASSET --to ASSET [--label TEXT]) [--json]',
} as const;

export type MutationCommand = keyof typeof USAGE;

export function mutationCommandUsage(command: MutationCommand): string {
  return `Usage: makefx ${USAGE[command]}`;
}

function required(parsed: ParsedArgs, name: string, command: MutationCommand): string {
  const value = parsed.options[name];
  if (!value || value === 'true') throw new CliUsageError(`${command} requires --${name} <value>.`);
  return value;
}

function optional(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === 'true') throw new CliUsageError(`--${name} requires a value.`);
  return value;
}

function rejectUnexpected(parsed: ParsedArgs, command: MutationCommand, options: string[]): void {
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(
      `${command} does not accept "${parsed.positionals[0]}". ${mutationCommandUsage(command)}`,
    );
  }
  const allowed = new Set([...GLOBAL_OPTIONS, ...options]);
  const unexpected = Object.keys(parsed.options).find((option) => !allowed.has(option));
  if (unexpected) {
    throw new CliUsageError(`Unknown option --${unexpected}. ${mutationCommandUsage(command)}`);
  }
}

function jsonOption(parsed: ParsedArgs, name: string): unknown {
  const value = optional(parsed, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliUsageError(`--${name} must be valid JSON.`);
  }
}

function nullableText(parsed: ParsedArgs, name: string): string | null | undefined {
  const value = optional(parsed, name);
  return value === 'null' ? null : value;
}

function booleanOption(parsed: ParsedArgs, name: string): boolean | undefined {
  const value = parsed.options[name];
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliUsageError(`--${name} must be true or false.`);
}

function objectOption(parsed: ParsedArgs, name: string): Record<string, unknown> | undefined {
  const value = jsonOption(parsed, name);
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliUsageError(`--${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function tagsOption(parsed: ParsedArgs): unknown[] | undefined {
  const value = jsonOption(parsed, 'tags');
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) {
    throw new CliUsageError('--tags must be a JSON array of strings.');
  }
  return value;
}

export function mutationToolCall(
  command: MutationCommand,
  parsed: ParsedArgs,
  requestId?: string,
): { name: string; args: Record<string, unknown> } {
  switch (command) {
    case 'voices sync':
      rejectUnexpected(parsed, command, ['account']);
      return { name: 'sync_voices', args: { account_id: required(parsed, 'account', command) } };
    case 'profile update': {
      rejectUnexpected(parsed, command, ['name']);
      const name = required(parsed, 'name', command);
      if (!name.trim()) throw new CliUsageError('profile update requires a non-empty --name.');
      return { name: 'update_profile', args: { name } };
    }
    case 'space update': {
      rejectUnexpected(parsed, command, ['space', 'name']);
      const name = required(parsed, 'name', command);
      if (!name.trim()) throw new CliUsageError('space update requires a non-empty --name.');
      return { name: 'update_space', args: { space_id: required(parsed, 'space', command), name } };
    }
    case 'asset update': {
      rejectUnexpected(parsed, command, [
        'space',
        'asset',
        'name',
        'note',
        'traits',
        'tags',
        'starred',
        'position',
        'recipe',
      ]);
      const name = optional(parsed, 'name');
      const note = nullableText(parsed, 'note');
      const traits = nullableText(parsed, 'traits');
      const tags = tagsOption(parsed);
      const starred = booleanOption(parsed, 'starred');
      const position = objectOption(parsed, 'position');
      const recipe = objectOption(parsed, 'recipe');
      return {
        name: 'update_asset',
        args: {
          space_id: required(parsed, 'space', command),
          asset_id: required(parsed, 'asset', command),
          ...(name !== undefined ? { name } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(traits !== undefined ? { traits } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(starred !== undefined ? { starred } : {}),
          ...(position !== undefined ? { position } : {}),
          ...(recipe !== undefined ? { recipe } : {}),
        },
      };
    }
    case 'asset delete':
      rejectUnexpected(parsed, command, ['space', 'asset']);
      return {
        name: 'delete_asset',
        args: {
          space_id: required(parsed, 'space', command),
          asset_id: required(parsed, 'asset', command),
        },
      };
    case 'describe':
      rejectUnexpected(parsed, command, ['space', 'asset', 'request-id']);
      const describeRequestId = optional(parsed, 'request-id') ?? requestId;
      if (!describeRequestId) throw new CliUsageError('describe requires a non-empty request id.');
      return {
        name: 'describe_asset',
        args: {
          space_id: required(parsed, 'space', command),
          asset_id: required(parsed, 'asset', command),
          request_id: describeRequestId,
        },
      };
    case 'link': {
      rejectUnexpected(parsed, command, ['space', 'from', 'to', 'label']);
      const label = optional(parsed, 'label');
      return {
        name: 'link_assets',
        args: {
          space_id: required(parsed, 'space', command),
          from_asset_id: required(parsed, 'from', command),
          to_asset_id: required(parsed, 'to', command),
          ...(label !== undefined ? { label } : {}),
        },
      };
    }
    case 'unlink': {
      rejectUnexpected(parsed, command, ['space', 'link', 'from', 'to', 'label']);
      const linkId = optional(parsed, 'link');
      const from = optional(parsed, 'from');
      const to = optional(parsed, 'to');
      const label = optional(parsed, 'label');
      if (linkId && (from !== undefined || to !== undefined || label !== undefined)) {
        throw new CliUsageError(
          `unlink accepts --link or --from/--to, not both. ${mutationCommandUsage(command)}`,
        );
      }
      if (!linkId && (!from || !to)) {
        throw new CliUsageError(
          `unlink requires --link or both --from and --to. ${mutationCommandUsage(command)}`,
        );
      }
      return {
        name: 'unlink_assets',
        args: {
          space_id: required(parsed, 'space', command),
          ...(linkId
            ? { link_id: linkId }
            : {
                from_asset_id: from,
                to_asset_id: to,
                ...(label !== undefined ? { label } : {}),
              }),
        },
      };
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function humanOutput(
  command: MutationCommand,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
): string {
  if (command === 'voices sync') {
    return `${String(result.account_id)} · ${String(result.active_voice_count)} active voices · synced ${new Date(Number(result.synced_at)).toISOString()}`;
  }
  if (command === 'profile update') {
    const user = record(result.user) ?? {};
    return [user.id, user.email, user.name]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join(' · ');
  }
  if (command === 'space update') {
    const space = record(result.space) ?? {};
    return [space.space_id, space.name, space.is_public === true ? 'public' : 'private', space.web_url]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join(' · ');
  }
  if (command === 'asset update') {
    const asset = record(result.asset) ?? {};
    return [asset.asset_id, asset.web_url].filter((value) => typeof value === 'string').join(' ');
  }
  if (command === 'asset delete') return `Deleted ${String(result.asset_id)}`;
  if (command === 'describe') {
    return [result.asset_id, result.web_url].filter((value) => typeof value === 'string').join(' ');
  }
  if (command === 'link') {
    const link = record(result.link) ?? {};
    return [link.link_id, `${String(link.from_asset_id)} -> ${String(link.to_asset_id)}`]
      .filter((value) => typeof value === 'string')
      .join(' ');
  }
  return typeof args.link_id === 'string'
    ? `Unlinked ${args.link_id}`
    : `Unlinked ${String(args.from_asset_id)} -> ${String(args.to_asset_id)}`;
}

export async function handleMutationCommand(
  command: MutationCommand,
  parsed: ParsedArgs,
  dependencies: MutationDependencies = defaults,
): Promise<void> {
  const requestId = command === 'describe' ? (parsed.options['request-id'] ?? dependencies.id()) : undefined;
  const call = mutationToolCall(command, parsed, requestId);
  const client = await dependencies.client(parsed);
  const result = await client.call(call.name, call.args);
  if (parsed.options.json === 'true') {
    dependencies.write(JSON.stringify(result, null, 2));
    return;
  }
  dependencies.write(humanOutput(command, result, call.args));
}
