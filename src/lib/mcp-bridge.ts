import type { StoredConfig } from './types.ts';
import { mcpRequestHeaders } from './mcp-transport.ts';
import { refreshStoredToken } from './tokens.ts';

export type BridgeOutcome =
  /** A notification: the server acknowledged it and there is nothing to write back. */
  | { kind: 'accepted' }
  /** An answer to relay to the client verbatim. */
  | { kind: 'response'; text: string }
  /** The credentials no longer work and could not be refreshed. */
  | { kind: 'unauthorized'; text: string }
  /** The request never reached the server. */
  | { kind: 'unreachable'; message: string };

export interface BridgeOptions {
  config: StoredConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Forwards one stdio message at a time to the HTTP endpoint, keeping the
 * token fresh as it goes.
 *
 * A 401 means the access token expired or its grant was revoked. One refresh
 * is attempted and the request retried; the refresh is single-flight, so two
 * requests that fail together share one refresh rather than presenting the
 * same refresh token twice, which the server would read as theft and revoke
 * the grant over.
 */
export function createMcpBridge(options: BridgeOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let config = options.config;
  let refreshing: Promise<StoredConfig | null> | null = null;
  const endpoint = new URL('/mcp', config.baseUrl).toString();

  async function send(line: string, accessToken: string): Promise<Response> {
    return fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        ...mcpRequestHeaders(line),
      },
      body: line,
    });
  }

  /** The token to retry with after a 401, or null when there is none. */
  async function tokenAfterRejection(rejectedToken: string): Promise<string | null> {
    // Another message already refreshed; the rejection was for the old token.
    if (config.token.accessToken !== rejectedToken) {
      return config.token.accessToken;
    }
    refreshing ??= refreshStoredToken(config, fetchImpl).finally(() => {
      refreshing = null;
    });
    const refreshed = await refreshing;
    if (!refreshed) {
      return null;
    }
    config = refreshed;
    return config.token.accessToken;
  }

  async function forward(line: string): Promise<BridgeOutcome> {
    let response: Response;
    try {
      const token = config.token.accessToken;
      response = await send(line, token);
      if (response.status === 401) {
        const retryToken = await tokenAfterRejection(token);
        if (retryToken) {
          response = await send(line, retryToken);
        }
      }
    } catch (error) {
      return { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) };
    }

    if (response.status === 202) {
      return { kind: 'accepted' };
    }
    const text = (await response.text()).trim();
    if (response.status === 401) {
      return { kind: 'unauthorized', text };
    }
    return { kind: 'response', text };
  }

  return { forward, currentConfig: () => config };
}
