import { cliCommand } from './auth.ts';
import { DEFAULT_ENVIRONMENT, loadStoredConfig } from './config.ts';
import { createMcpBridge } from './mcp-bridge.ts';
import { ensureFreshConfig } from './tokens.ts';
import type { ParsedArgs, StoredConfig } from './types.ts';
import { ToolCallError } from './errors.ts';

const MCP_VERSION = '2026-07-28';

export interface ToolClient {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function responseJson(text: string): unknown {
  if (text.startsWith('{')) return JSON.parse(text);
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .at(-1);
  if (!data) throw new Error('The MCP server returned no response.');
  return JSON.parse(data);
}

export function createToolClient(config: StoredConfig, fetchImpl: typeof fetch = fetch): ToolClient {
  const bridge = createMcpBridge({ config, fetchImpl });
  let nextId = 1;
  return {
    async call(name, args) {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      });
      const outcome = await bridge.forward(line);
      if (outcome.kind === 'unreachable') throw new Error(`MCP request failed: ${outcome.message}`);
      if (outcome.kind === 'unauthorized') throw new Error('The stored login was rejected. Sign in again.');
      if (outcome.kind === 'accepted')
        throw new Error('The MCP server accepted a call without returning its result.');
      const envelope = responseJson(outcome.text) as {
        error?: { message?: string };
        result?: {
          isError?: boolean;
          content?: Array<{ type?: string; text?: string }>;
          structuredContent?: Record<string, unknown>;
        };
      };
      if (envelope.error) throw new Error(envelope.error.message ?? 'MCP protocol error.');
      const result = envelope.result;
      if (!result) throw new Error('The MCP server returned no tool result.');
      if (result.isError) {
        const fallback = result.content?.find(({ type }) => type === 'text')?.text ?? 'The tool call failed.';
        throw new ToolCallError(
          result.structuredContent ?? {
            code: 'tool_error',
            message: fallback,
            retryable: false,
          },
          fallback,
        );
      }
      if (!result.structuredContent) throw new Error('The tool returned no structured result.');
      return result.structuredContent;
    },
  };
}

export async function authenticatedToolClient(parsed: ParsedArgs): Promise<ToolClient> {
  return createToolClient(await authenticatedConfig(parsed));
}

/** Load the person's stored OAuth grant for CLI commands that call REST directly. */
export async function authenticatedConfig(parsed: ParsedArgs): Promise<StoredConfig> {
  const environment = parsed.options.local === 'true' ? 'local' : (parsed.options.env ?? DEFAULT_ENVIRONMENT);
  const hint = `Run: ${cliCommand()} login --env ${environment}`;
  const stored = await loadStoredConfig(environment);
  if (!stored) throw new Error(`Not logged in for "${environment}". ${hint}`);
  const config = await ensureFreshConfig(stored);
  if (!config) throw new Error(`Credentials for "${environment}" have expired. ${hint}`);
  return config;
}
