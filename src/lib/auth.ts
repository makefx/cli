import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { Buffer as NodeBuffer } from 'node:buffer';
import { getSuccessPage, getErrorPage } from './auth-pages.ts';

/**
 * The browser half of `login`: PKCE, the loopback callback server, and the
 * pages it shows. Talking to the token endpoint lives in tokens.ts.
 */
export const DEFAULT_CLIENT_ID = 'cli';
export const DEFAULT_REDIRECT_PORT = 8765;
// read and write are what the MCP tools check; the identity scopes name the person.
export const AUTH_SCOPES = 'openid profile email read write';

export function cliCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.npm_command === 'exec' ? 'npx makefx' : 'makefx';
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const hash = createHash('sha256').update(codeVerifier).digest();
  return base64UrlEncode(hash);
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

function base64UrlEncode(buffer: NodeBuffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function waitForAuthorizationCode(
  port: number,
  expectedState: string,
): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getErrorPage('invalid_request', 'Invalid request'));
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(getErrorPage('not_found', 'Page not found'));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');

      // Only a callback carrying this login's state may end it. Anything else
      // reaching the loopback port, such as another page in the browser, is
      // refused without cancelling or answering the login.
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getErrorPage('invalid_request', 'This callback does not belong to the login in progress.'));
        return;
      }

      // Handle OAuth error response
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getErrorPage(error, errorDescription || undefined));
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getErrorPage('invalid_request', 'Missing authorization code'));
        clearTimeout(timeout);
        server.close();
        reject(new Error('Missing authorization code'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getSuccessPage());

      clearTimeout(timeout);
      server.close();
      resolve({ code });
    });

    server.listen(port, '127.0.0.1');

    server.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start local callback server: ${error.message}`));
    });

    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error('Login timed out waiting for authorization response'));
      },
      5 * 60 * 1000,
    );
  });
}

export async function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '""', url];
    } else {
      command = 'xdg-open';
      args = [url];
    }

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', (error) => reject(error));
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
