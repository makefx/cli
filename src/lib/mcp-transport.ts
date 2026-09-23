/**
 * The headers the 2026-07-28 MCP transport expects alongside a request.
 *
 * A stdio client knows nothing about HTTP, so the bridge derives them from
 * each message: the protocol version it declares, its method, and for a tool
 * call the tool's name. A message that declares no version is a legacy one
 * and travels with no extra headers.
 */
import { isRecord } from './json.ts';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

/** Header values must be printable ASCII; anything else is base64-wrapped. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x21-\x7E]+$/.test(value)) {
    return value;
  }
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function mcpRequestHeaders(line: string): Record<string, string> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return {};
  }
  if (!isRecord(message) || typeof message.method !== 'string') {
    return {};
  }

  const params = isRecord(message.params) ? message.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const version = meta[PROTOCOL_VERSION_META_KEY];
  if (typeof version !== 'string') {
    return {};
  }

  const headers: Record<string, string> = {
    'MCP-Protocol-Version': version,
    'Mcp-Method': message.method,
  };
  if (message.method === 'tools/call' && typeof params.name === 'string') {
    headers['Mcp-Name'] = encodeHeaderValue(params.name);
  }
  return headers;
}
