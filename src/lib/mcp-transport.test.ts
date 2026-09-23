import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { encodeHeaderValue, mcpRequestHeaders } from './mcp-transport.ts';

const MODERN = '2026-07-28';

function modern(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
  });
}

describe('mcpRequestHeaders', () => {
  test('a legacy message travels with no extra headers', () => {
    assert.deepEqual(mcpRequestHeaders(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })), {});
    assert.deepEqual(mcpRequestHeaders('not json'), {});
    assert.deepEqual(mcpRequestHeaders('[]'), {});
  });

  test('a modern message mirrors its version and method', () => {
    assert.deepEqual(mcpRequestHeaders(modern('tools/list')), {
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': 'tools/list',
    });
  });

  test('a tool call also names the tool, base64-wrapped when it is not plain ASCII', () => {
    assert.deepEqual(mcpRequestHeaders(modern('tools/call', { name: 'get_profile', arguments: {} })), {
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'get_profile',
    });
    assert.equal(encodeHeaderValue('naïve'), `=?base64?${Buffer.from('naïve', 'utf8').toString('base64')}?=`);
    assert.equal(
      encodeHeaderValue('with space'),
      `=?base64?${Buffer.from('with space', 'utf8').toString('base64')}?=`,
    );
  });
});
