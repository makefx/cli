import process from 'node:process';
import { cliCommand } from '../lib/auth.ts';
import { DEFAULT_ENVIRONMENT, loadStoredConfig } from '../lib/config.ts';
import { createMcpBridge } from '../lib/mcp-bridge.ts';
import { ensureFreshConfig } from '../lib/tokens.ts';
import type { ParsedArgs } from '../lib/types.ts';

/**
 * Bridges a local MCP client to the deployed MCP endpoint.
 *
 * Desktop MCP clients launch a subprocess and speak newline-delimited
 * JSON-RPC over stdio, while the server is an HTTP endpoint. This forwards
 * between the two and attaches the token from `login`, refreshing it as
 * needed, so the client never handles credentials itself.
 *
 * Register it with a client as:
 *   { "command": "makefx", "args": ["mcp", "--env", "stage"] }
 */
export async function handleMcp(parsed: ParsedArgs): Promise<void> {
  const env = parsed.options.local === 'true' ? 'local' : (parsed.options.env ?? DEFAULT_ENVIRONMENT);
  const loginHint = `Run: ${cliCommand()} login --env ${env}`;

  // stderr throughout, because stdout is the protocol channel.
  const stored = await loadStoredConfig(env);
  if (!stored) {
    console.error(`Not logged in for "${env}". ${loginHint}`);
    process.exitCode = 1;
    return;
  }

  const config = await ensureFreshConfig(stored);
  if (!config) {
    console.error(`Credentials for "${env}" have expired. ${loginHint}`);
    process.exitCode = 1;
    return;
  }

  const bridge = createMcpBridge({ config });

  async function forward(line: string): Promise<void> {
    const outcome = await bridge.forward(line);
    switch (outcome.kind) {
      case 'accepted':
        return;
      case 'response':
        if (outcome.text) process.stdout.write(`${outcome.text}\n`);
        return;
      case 'unauthorized':
        // The client still gets the JSON-RPC error for its request; the
        // person gets told what to do, and the bridge stops rather than
        // failing every call from here on.
        if (outcome.text) process.stdout.write(`${outcome.text}\n`);
        console.error(`Access to "${env}" was revoked or has expired. ${loginHint}`);
        process.exitCode = 1;
        process.stdin.destroy();
        return;
      case 'unreachable':
        console.error(`MCP request failed: ${outcome.message}`);
        return;
    }
  }

  // Messages are newline-delimited, but a chunk may split or combine them.
  let buffer = '';
  const pending: Promise<void>[] = [];

  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        pending.push(forward(line));
      }
      newline = buffer.indexOf('\n');
    }
  }

  await Promise.all(pending);
}
