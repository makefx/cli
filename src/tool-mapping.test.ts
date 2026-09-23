import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CLI_MCP_TOOL_EXCEPTIONS, CLI_MCP_TOOL_MAPPING } from './tool-mapping.ts';

// The service's public MCP tool names; see CONTRIBUTING.md for how the snapshot is refreshed.
const MCP_TOOLS = JSON.parse(
  readFileSync(new URL('../test/fixtures/mcp-tools.json', import.meta.url), 'utf8'),
) as string[];

test('every public MCP tool have a dedicated CLI command or an approved exception', () => {
  const publicTools = [...MCP_TOOLS].sort();
  const mappedTools = Object.keys(CLI_MCP_TOOL_MAPPING).sort();
  const exceptedTools = Object.keys(CLI_MCP_TOOL_EXCEPTIONS).sort();

  assert.deepEqual([...mappedTools, ...exceptedTools].sort(), publicTools);
  assert.equal(new Set(Object.values(CLI_MCP_TOOL_MAPPING)).size, mappedTools.length);
  for (const [tool, reason] of Object.entries(CLI_MCP_TOOL_EXCEPTIONS)) {
    assert.ok(reason.trim(), `${tool} must have a documented product-approved exception`);
  }
});
