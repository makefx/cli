import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createMcpBridge } from './mcp-bridge.ts';
import type { StoredConfig } from './types.ts';

const BASE_URL = 'https://stage.example.com';
const MODERN = '2026-07-28';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function config(): StoredConfig {
  return {
    environment: 'stage',
    baseUrl: BASE_URL,
    clientId: 'cli',
    token: {
      accessToken: 'token-1',
      expiresAt: Date.now() + 3_600_000,
      issuedAt: Date.now(),
      refreshToken: 'rt_1',
      refreshExpiresAt: Date.now() + 86_400_000,
    },
    user: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * A stand-in for the deployment: answers discovery, mints token-2 on the
 * first refresh and refuses later ones, and treats a stale bearer as a 401.
 */
function fakeServer(options: { refreshable?: boolean } = {}) {
  const seen: Seen[] = [];
  const valid = new Set(['token-1']);
  let refreshes = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return Response.json({
        authorization_endpoint: `${BASE_URL}/api/oauth/authorize`,
        token_endpoint: `${BASE_URL}/api/oauth/token`,
      });
    }
    if (url.endsWith('/api/oauth/token')) {
      refreshes += 1;
      if (options.refreshable === false || refreshes > 1) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      valid.delete('token-1');
      valid.add('token-2');
      return Response.json({
        access_token: 'token-2',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt_2',
        refresh_token_expires_in: 100,
      });
    }

    const headers = init?.headers as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : '';
    seen.push({ url, headers, body });
    if (!valid.has(headers.Authorization.replace('Bearer ', ''))) {
      return Response.json(
        { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Authentication required' } },
        { status: 401 },
      );
    }
    const message = JSON.parse(body) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } });
  };

  return { fetchImpl, seen, expire: () => valid.delete('token-1'), refreshCount: () => refreshes };
}

describe('MCP bridge', () => {
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'cli-bridge-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(configHome, { recursive: true, force: true });
  });

  test('forwards a legacy message as is and a modern one with mirrored headers', async () => {
    const server = fakeServer();
    const bridge = createMcpBridge({ config: config(), fetchImpl: server.fetchImpl });

    const legacy = await bridge.forward(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    assert.deepEqual(legacy, {
      kind: 'response',
      text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { echoed: 'initialize' } }),
    });
    assert.equal(server.seen[0]?.url, `${BASE_URL}/mcp`);
    assert.equal(server.seen[0]?.headers['Mcp-Method'], undefined);
    assert.equal(server.seen[0]?.headers.Authorization, 'Bearer token-1');

    await bridge.forward(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_profile',
          arguments: {},
          _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN },
        },
      }),
    );
    assert.equal(server.seen[1]?.headers['MCP-Protocol-Version'], MODERN);
    assert.equal(server.seen[1]?.headers['Mcp-Method'], 'tools/call');
    assert.equal(server.seen[1]?.headers['Mcp-Name'], 'get_profile');

    const notification = await bridge.forward(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    assert.deepEqual(notification, { kind: 'accepted' });
  });

  test('a 401 triggers one refresh shared by every message in flight, then a retry', async () => {
    const server = fakeServer();
    const bridge = createMcpBridge({ config: config(), fetchImpl: server.fetchImpl });
    server.expire();

    const outcomes = await Promise.all([
      bridge.forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })),
      bridge.forward(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })),
    ]);

    assert.deepEqual(
      outcomes.map((outcome) => outcome.kind),
      ['response', 'response'],
    );
    assert.equal(server.refreshCount(), 1);
    assert.equal(bridge.currentConfig().token.accessToken, 'token-2');
    // Every retry carried the new token.
    assert.deepEqual(
      server.seen.slice(2).map((call) => call.headers.Authorization),
      ['Bearer token-2', 'Bearer token-2'],
    );
  });

  test('when the grant is gone the client still gets its error and the person gets told', async () => {
    const server = fakeServer({ refreshable: false });
    const bridge = createMcpBridge({ config: config(), fetchImpl: server.fetchImpl });
    server.expire();

    const outcome = await bridge.forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    assert.equal(outcome.kind, 'unauthorized');
    assert.match(outcome.kind === 'unauthorized' ? outcome.text : '', /Authentication required/);
  });

  test('a network failure is reported without touching the token', async () => {
    const bridge = createMcpBridge({
      config: config(),
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.deepEqual(await bridge.forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })), {
      kind: 'unreachable',
      message: 'ECONNREFUSED',
    });
    assert.equal(bridge.currentConfig().token.accessToken, 'token-1');
  });
});
