import process from 'node:process';
import { hostname } from 'node:os';
import type { ParsedArgs, StoredConfig } from '../lib/types.ts';
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_PORT,
  AUTH_SCOPES,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  waitForAuthorizationCode,
  openBrowser,
} from '../lib/auth.ts';
import {
  discoverAuthorizationServer,
  exchangeCodeForToken,
  mcpResourceFor,
  storedTokenFrom,
} from '../lib/tokens.ts';
import { DEFAULT_ENVIRONMENT, resolveBaseUrl, saveConfig, getConfigPath } from '../lib/config.ts';

export async function handleLogin(parsed: ParsedArgs) {
  // Handle --local flag
  const isLocal = parsed.options.local === 'true';
  const env = isLocal ? 'local' : (parsed.options.env ?? DEFAULT_ENVIRONMENT);
  const baseUrl = resolveBaseUrl(env);
  const clientId = DEFAULT_CLIENT_ID;
  const redirectPort = DEFAULT_REDIRECT_PORT;
  const insecure = isLocal;

  if (insecure) {
    console.log('⚠️  SSL certificate verification disabled (local dev mode)');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  console.log(`Starting login for environment "${env}" using ${baseUrl}`);

  const server = await discoverAuthorizationServer(baseUrl);

  const state = generateState();
  const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authUrl = new URL(server.authorizationEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', AUTH_SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', mcpResourceFor(baseUrl));

  console.log(`\nOpen this URL in your browser to authenticate:\n\n${authUrl.toString()}\n`);
  console.log(`The OAuth callback uses ${redirectUri} (port ${redirectPort}).`);
  const detectedHost = hostname();
  const sshHost = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(detectedHost) ? detectedHost : 'YOUR_SSH_HOST';
  console.log('If this CLI is on a remote host, run this in a separate terminal on the computer with your browser before opening the URL:');
  console.log(`  ssh -N -L ${redirectPort}:127.0.0.1:${redirectPort} ${sshHost}`);
  console.log('Use your usual SSH destination (user@host or SSH alias) if the detected hostname is not reachable. Keep the tunnel open until login finishes.\n');
  console.log('Opening browser for Google authentication...');
  try {
    await openBrowser(authUrl.toString());
  } catch {
    console.warn('Unable to open browser automatically. Please open the URL above in your browser.');
  }

  const { code } = await waitForAuthorizationCode(redirectPort, state);

  console.log('Received authorization code. Exchanging for access token...');
  const tokenResponse = await exchangeCodeForToken({
    baseUrl,
    tokenEndpoint: server.tokenEndpoint,
    code,
    codeVerifier,
    redirectUri,
    clientId,
  });

  const storedConfig: StoredConfig = {
    environment: env,
    baseUrl,
    clientId,
    token: storedTokenFrom(tokenResponse),
    user: tokenResponse.user ?? null,
    updatedAt: new Date().toISOString(),
  };

  await saveConfig(storedConfig);
  console.log(`Login successful. Credentials saved to ${await getConfigPath()}`);
  if (!storedConfig.token.refreshToken) {
    console.log('No refresh token was issued; you will need to log in again when the session expires.');
  }
}
