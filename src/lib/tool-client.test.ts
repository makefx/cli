import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredConfig } from './types.ts';
import { createToolClient } from './tool-client.ts';
import { ToolCallError } from './errors.ts';

function config(): StoredConfig {
  return {
    environment: 'stage',
    baseUrl: 'https://stage.example.com',
    clientId: 'cli',
    token: { accessToken: 'token', expiresAt: Date.now() + 60_000, issuedAt: Date.now() },
    user: null,
    updatedAt: new Date().toISOString(),
  };
}

test('calls a public MCP tool and returns structuredContent', async () => {
  let request: { method?: string; params?: Record<string, unknown> } = {};
  const client = createToolClient(config(), async (_input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') throw new TypeError('Expected a string request body.');
    request = JSON.parse(body) as typeof request;
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [], structuredContent: { assets: [{ asset_id: 'as_frame' }] } },
    });
  });

  assert.deepEqual(await client.call('create_asset', { model: 'image/frame' }), {
    assets: [{ asset_id: 'as_frame' }],
  });
  assert.equal(request.method, 'tools/call');
  assert.deepEqual(request.params, {
    name: 'create_asset',
    arguments: { model: 'image/frame' },
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  });
});

test('preserves structured MCP tool errors', async () => {
  const structuredContent = {
    code: 'insufficient_credits',
    message: 'More credits are required.',
    retryable: false,
    details: { topup_url: 'https://makefx.app/settings/billing' },
  };
  const client = createToolClient(config(), async () =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'More credits are required.' }],
        structuredContent,
      },
    }),
  );

  await assert.rejects(client.call('create_asset', {}), (error) => {
    assert.ok(error instanceof ToolCallError);
    assert.deepEqual(error.structuredContent, structuredContent);
    assert.equal(error.code, 'insufficient_credits');
    assert.equal(error.details?.topup_url, 'https://makefx.app/settings/billing');
    return true;
  });
});
