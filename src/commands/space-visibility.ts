import { CliUsageError, ToolCallError } from '../lib/errors.ts';
import { isRecord } from '../lib/json.ts';
import { parseCanonicalSpaceId } from '../lib/space-id.ts';
import { authenticatedConfig } from '../lib/tool-client.ts';
import type { ParsedArgs, StoredConfig } from '../lib/types.ts';

export type SpaceVisibilityCommand = 'space publish' | 'space unpublish';

/** `PATCH /api/spaces/:accountId/:spaceId`: the space as it now stands. */
type SpaceUpdateResponse = {
  space: { space_id: string; is_public: boolean; web_url: string } & Record<string, unknown>;
};

const SPACE_UPDATE_PATH = '/api/spaces/:accountId/:spaceId';

type SpaceVisibilityDependencies = {
  authenticate: (parsed: ParsedArgs) => Promise<StoredConfig>;
  fetch: typeof fetch;
  write: (text: string) => void;
};

const defaults: SpaceVisibilityDependencies = {
  authenticate: authenticatedConfig,
  fetch,
  write: (text) => process.stdout.write(`${text}\n`),
};

export function spaceVisibilityUsage(command: SpaceVisibilityCommand): string {
  return `Usage: makefx ${command} --space ACCOUNT/SPACE [--json]`;
}

function spaceId(parsed: ParsedArgs, command: SpaceVisibilityCommand): string {
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(
      `${command} does not accept "${parsed.positionals[0]}". ${spaceVisibilityUsage(command)}`,
    );
  }
  const allowed = new Set(['env', 'local', 'json', 'space']);
  const unexpected = Object.keys(parsed.options).find((option) => !allowed.has(option));
  if (unexpected) {
    throw new CliUsageError(`Unknown option --${unexpected}. ${spaceVisibilityUsage(command)}`);
  }
  const value = parsed.options.space;
  if (!value || value === 'true') throw new CliUsageError(`${command} requires --space <value>.`);
  if (!parseCanonicalSpaceId(value)) {
    throw new CliUsageError(`${command} requires --space ACCOUNT/SPACE.`);
  }
  return value;
}

function routePath(accountId: string, spaceId: string): string {
  return SPACE_UPDATE_PATH
    .replace(':accountId', encodeURIComponent(accountId))
    .replace(':spaceId', encodeURIComponent(spaceId));
}

async function responseError(response: Response, messageOverride?: string): Promise<Error> {
  const payload = await response.json().catch(() => undefined);
  const value = (
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
  ) as {
    error?: unknown;
    error_description?: unknown;
    retryable?: unknown;
  } | null;
  const code = typeof value?.error === 'string' ? value.error : `http_${response.status}`;
  const message =
    messageOverride ??
    (typeof value?.error_description === 'string'
      ? value.error_description
      : typeof value?.error === 'string'
        ? value.error
        : `Space visibility update failed (${response.status}).`);
  return new ToolCallError(
    {
      code,
      message,
      retryable:
        typeof value?.retryable === 'boolean'
          ? value.retryable
          : response.status === 429 || response.status >= 500,
      details: { http_status: response.status },
    },
    message,
    payload,
  );
}

export async function setSpaceVisibility(
  config: StoredConfig,
  canonicalId: string,
  isPublic: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceUpdateResponse> {
  const parsed = parseCanonicalSpaceId(canonicalId);
  if (!parsed) throw new CliUsageError('--space must be ACCOUNT/SPACE.');
  const response = await fetchImpl(new URL(routePath(parsed.accountId, parsed.spaceId), config.baseUrl), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${config.token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ is_public: isPublic }),
  });
  if (!response.ok) {
    throw await responseError(
      response,
      response.status === 401 ? 'The stored login was rejected. Sign in again.' : undefined,
    );
  }
  return spaceUpdateResponse(await response.json());
}

function spaceUpdateResponse(payload: unknown): SpaceUpdateResponse {
  const space = isRecord(payload) ? payload.space : undefined;
  if (
    !isRecord(space) ||
    typeof space.space_id !== 'string' ||
    typeof space.is_public !== 'boolean' ||
    typeof space.web_url !== 'string'
  ) {
    throw new Error('The space update response was not a space.');
  }
  return { space: { ...space, space_id: space.space_id, is_public: space.is_public, web_url: space.web_url } };
}

export async function handleSpaceVisibilityCommand(
  command: SpaceVisibilityCommand,
  parsed: ParsedArgs,
  dependencies: SpaceVisibilityDependencies = defaults,
): Promise<void> {
  const canonicalId = spaceId(parsed, command);
  const config = await dependencies.authenticate(parsed);
  const result = await setSpaceVisibility(
    config,
    canonicalId,
    command === 'space publish',
    dependencies.fetch,
  );
  if (parsed.options.json === 'true') {
    dependencies.write(JSON.stringify(result, null, 2));
    return;
  }
  dependencies.write(
    `${result.space.space_id} · ${result.space.is_public ? 'public' : 'private'} · ${result.space.web_url}`,
  );
}
