import type { StoredConfig, StoredToken } from './types.ts';
import { loadStoredConfig, saveConfigHoldingLock, withConfigLock } from './config.ts';

/**
 * The CLI's side of the OAuth token lifecycle: finding the endpoints,
 * exchanging a code, refreshing, and revoking. Requests are form-encoded, as
 * RFC 6749 requires and as every other OAuth client sends them, so the CLI
 * exercises the same server path a hosted client does.
 */
export interface AuthorizationServer {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  user?: unknown;
}

/** Refresh this long before the access token expires, so a call never races the deadline. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/**
 * Bound on each network call made while holding the config lock. Two calls
 * at most, so the lock is held for well under its stale threshold.
 */
export const REFRESH_TIMEOUT_MS = 10_000;

/**
 * The token is minted for the MCP endpoint (RFC 8707), which is where the
 * CLI's `mcp` bridge presents it. The API accepts MCP-audience tokens too, so
 * nothing else the CLI does is affected.
 */
export function mcpResourceFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/mcp`;
}

function requireUrl(document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Authorization server metadata is missing ${field}`);
  }
  return value;
}

/** RFC 8414 discovery: the document MCP clients read, so the CLI follows the same endpoints. */
export async function discoverAuthorizationServer(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AuthorizationServer> {
  // Self-signed local certs are handled by the caller via
  // NODE_TLS_REJECT_UNAUTHORIZED; fetch() has no per-request TLS option.
  const response = await fetchImpl(`${baseUrl}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load authorization server metadata (${response.status})`);
  }

  const document = (await response.json()) as Record<string, unknown>;
  const revocationEndpoint = document.revocation_endpoint;
  return {
    authorizationEndpoint: requireUrl(document, 'authorization_endpoint'),
    tokenEndpoint: requireUrl(document, 'token_endpoint'),
    ...(typeof revocationEndpoint === 'string' ? { revocationEndpoint } : {}),
  };
}

export class TokenRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'TokenRequestError';
    this.status = status;
    this.code = code;
  }
}

async function postForm(
  endpoint: string,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal,
  });
}

async function readTokenResponse(response: Response): Promise<TokenResponse> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new TokenRequestError(
      response.status,
      typeof body.error === 'string' ? body.error : `http_${response.status}`,
      typeof body.error_description === 'string' ? body.error_description : undefined,
    );
  }
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error('Token response is missing access_token or expires_in');
  }
  return body as unknown as TokenResponse;
}

export function storedTokenFrom(response: TokenResponse, now = Date.now()): StoredToken {
  return {
    accessToken: response.access_token,
    expiresAt: now + response.expires_in * 1000,
    issuedAt: now,
    scope: response.scope,
    ...(response.refresh_token
      ? {
          refreshToken: response.refresh_token,
          refreshExpiresAt: now + (response.refresh_token_expires_in ?? 0) * 1000,
        }
      : {}),
  };
}

export async function exchangeCodeForToken(
  input: {
    baseUrl: string;
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await postForm(
    input.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      resource: mcpResourceFor(input.baseUrl),
    },
    fetchImpl,
  );
  return readTokenResponse(response);
}

/** Whether the access token still has comfortably more than the margin left. */
export function isAccessTokenFresh(token: StoredToken, now = Date.now()): boolean {
  return token.expiresAt - now > REFRESH_MARGIN_MS;
}

export function canRefresh(token: StoredToken, now = Date.now()): boolean {
  return Boolean(token.refreshToken) && (token.refreshExpiresAt ?? 0) > now;
}

/**
 * Trades the stored refresh token for the next one and saves the result
 * before returning, so the consumed token is never presented twice. Returns
 * null when the server will not refresh, which means a login is needed.
 *
 * Runs under the config lock and re-reads the file first: another process
 * for the same environment may have refreshed already, in which case its
 * token is the live one and presenting ours would read as a replay.
 */
export async function refreshStoredToken(
  config: StoredConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredConfig | null> {
  if (!canRefresh(config.token)) {
    return null;
  }

  return withConfigLock(async () => {
    const stored = await loadStoredConfig(config.environment);
    if (
      stored &&
      stored.token.accessToken !== config.token.accessToken &&
      stored.token.expiresAt > Date.now()
    ) {
      return stored;
    }
    const current = stored ?? config;
    if (!canRefresh(current.token)) {
      return null;
    }
    return refreshUnlocked(current, fetchImpl);
  });
}

async function refreshUnlocked(config: StoredConfig, fetchImpl: typeof fetch): Promise<StoredConfig | null> {
  const server = await discoverAuthorizationServer(
    config.baseUrl,
    fetchImpl,
    AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  );
  const response = await postForm(
    server.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: config.token.refreshToken ?? '',
      client_id: config.clientId,
      resource: mcpResourceFor(config.baseUrl),
    },
    fetchImpl,
    AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  );

  let tokens: TokenResponse;
  try {
    tokens = await readTokenResponse(response);
  } catch (error) {
    // invalid_grant is the server saying the grant is over: revoked,
    // expired, or replayed. Anything else is worth surfacing as is.
    if (error instanceof TokenRequestError && error.status === 400) {
      return null;
    }
    throw error;
  }

  const refreshed: StoredConfig = {
    ...config,
    token: storedTokenFrom(tokens),
    user: tokens.user ?? config.user,
    updatedAt: new Date().toISOString(),
  };
  await saveConfigHoldingLock(refreshed);
  return refreshed;
}

/** The stored credentials, refreshed if they are about to expire. Null means log in again. */
export async function ensureFreshConfig(
  config: StoredConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredConfig | null> {
  if (isAccessTokenFresh(config.token)) {
    return config;
  }
  return refreshStoredToken(config, fetchImpl);
}

/** How long a logout waits for the server before forgetting the credentials anyway. */
export const REVOCATION_TIMEOUT_MS = 5_000;

/**
 * RFC 7009: tells the server the grant is over, so it disappears from the
 * person's connected apps rather than lingering until it expires. Best
 * effort and bounded: an unreachable or hanging server must not stop a
 * logout.
 */
export async function revokeStoredToken(
  config: StoredConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REVOCATION_TIMEOUT_MS,
): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const server = await discoverAuthorizationServer(config.baseUrl, fetchImpl, signal);
    if (!server.revocationEndpoint) {
      return false;
    }
    const token = config.token.refreshToken ?? config.token.accessToken;
    const response = await postForm(
      server.revocationEndpoint,
      {
        token,
        token_type_hint: config.token.refreshToken ? 'refresh_token' : 'access_token',
        client_id: config.clientId,
      },
      fetchImpl,
      signal,
    );
    return response.ok;
  } catch {
    return false;
  }
}
