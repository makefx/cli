import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { StoredConfig } from './types.ts';
import {
  discoverAuthorizationServer,
  ensureFreshConfig,
  exchangeCodeForToken,
  refreshStoredToken,
  revokeStoredToken,
  storedTokenFrom,
} from './tokens.ts';
import { CONFIG_DIR_NAME } from './project.ts';

const BASE_URL = 'https://stage.example.com';
const METADATA = {
  authorization_endpoint: `${BASE_URL}/api/oauth/authorize`,
  token_endpoint: `${BASE_URL}/api/oauth/token`,
  revocation_endpoint: `${BASE_URL}/api/oauth/revoke`,
};

interface Call {
  url: string;
  body: URLSearchParams | null;
}

/** A fetch stand-in that serves discovery and records everything else. */
function fakeFetch(answer: (call: Call) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return Response.json(METADATA);
    }
    const call: Call = { url, body: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null };
    calls.push(call);
    assert.equal(
      init?.headers && (init.headers as Record<string, string>)['content-type'],
      'application/x-www-form-urlencoded',
    );
    return answer(call);
  };
  return { fetchImpl, calls };
}

function config(overrides: Partial<StoredConfig['token']> = {}): StoredConfig {
  return {
    environment: 'stage',
    baseUrl: BASE_URL,
    clientId: 'cli',
    token: {
      accessToken: 'old-access',
      expiresAt: Date.now() + 60_000,
      issuedAt: Date.now() - 1000,
      scope: 'openid read write',
      refreshToken: 'rt_old',
      refreshExpiresAt: Date.now() + 86_400_000,
      ...overrides,
    },
    user: { id: '1' },
    updatedAt: new Date().toISOString(),
  };
}

describe('CLI token lifecycle', () => {
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'cli-tokens-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(configHome, { recursive: true, force: true });
  });

  test('discovery reads the RFC 8414 document and requires the endpoints a login needs', async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({}));
    assert.deepEqual(await discoverAuthorizationServer(BASE_URL, fetchImpl), {
      authorizationEndpoint: METADATA.authorization_endpoint,
      tokenEndpoint: METADATA.token_endpoint,
      revocationEndpoint: METADATA.revocation_endpoint,
    });

    const incomplete: typeof fetch = async () => Response.json({ issuer: BASE_URL });
    await assert.rejects(() => discoverAuthorizationServer(BASE_URL, incomplete), /authorization_endpoint/);
  });

  test('a code exchange is form-encoded and names the MCP resource', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      Response.json({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt_1',
        refresh_token_expires_in: 60,
      }),
    );
    const response = await exchangeCodeForToken(
      {
        baseUrl: BASE_URL,
        tokenEndpoint: METADATA.token_endpoint,
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'http://127.0.0.1:8765/callback',
        clientId: 'cli',
      },
      fetchImpl,
    );
    assert.equal(response.access_token, 'a');
    assert.equal(calls[0]?.url, METADATA.token_endpoint);
    assert.equal(calls[0]?.body?.get('grant_type'), 'authorization_code');
    assert.equal(calls[0]?.body?.get('resource'), `${BASE_URL}/mcp`);

    const stored = storedTokenFrom(response, 1_000_000);
    assert.deepEqual(stored, {
      accessToken: 'a',
      expiresAt: 1_000_000 + 3_600_000,
      issuedAt: 1_000_000,
      scope: undefined,
      refreshToken: 'rt_1',
      refreshExpiresAt: 1_000_000 + 60_000,
    });
  });

  test('a refresh rotates the stored token and saves it before anything else happens', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      Response.json({
        access_token: 'new-access',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid read',
        refresh_token: 'rt_new',
        refresh_token_expires_in: 100,
      }),
    );

    const refreshed = await refreshStoredToken(config(), fetchImpl);
    assert.ok(refreshed);
    assert.equal(refreshed.token.accessToken, 'new-access');
    assert.equal(refreshed.token.refreshToken, 'rt_new');
    assert.equal(refreshed.token.scope, 'openid read');
    assert.equal(calls[0]?.body?.get('grant_type'), 'refresh_token');
    assert.equal(calls[0]?.body?.get('refresh_token'), 'rt_old');
    assert.equal(calls[0]?.body?.get('client_id'), 'cli');
    assert.equal(calls[0]?.body?.get('resource'), `${BASE_URL}/mcp`);

    // The rotated token is the only usable copy, so it is on disk already.
    const onDisk = JSON.parse(
      readFileSync(join(configHome, CONFIG_DIR_NAME, 'config.json'), 'utf8'),
    ) as {
      configs: Record<string, StoredConfig>;
    };
    assert.equal(onDisk.configs.stage?.token.refreshToken, 'rt_new');
  });

  test('the server refusing the grant means a login, and nothing else is retried', async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    assert.equal(await refreshStoredToken(config(), fetchImpl), null);
    assert.equal(calls.length, 1);

    // Without a refresh token, or with an expired one, there is nothing to present.
    assert.equal(await refreshStoredToken(config({ refreshToken: undefined }), fetchImpl), null);
    assert.equal(await refreshStoredToken(config({ refreshExpiresAt: Date.now() - 1 }), fetchImpl), null);
    assert.equal(calls.length, 1);

    // A throttle is not a refusal of the grant and is reported as such.
    const throttled = fakeFetch(() => Response.json({ error: 'slow_down' }, { status: 429 }));
    await assert.rejects(() => refreshStoredToken(config(), throttled.fetchImpl), /slow_down/);
  });

  test('a fresh access token is left alone; one about to expire is refreshed', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      Response.json({
        access_token: 'new',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt_new',
        refresh_token_expires_in: 100,
      }),
    );
    const fresh = config({ expiresAt: Date.now() + 3_600_000 });
    assert.equal(await ensureFreshConfig(fresh, fetchImpl), fresh);
    assert.equal(calls.length, 0);

    const stale = await ensureFreshConfig(config({ expiresAt: Date.now() + 60_000 }), fetchImpl);
    assert.equal(stale?.token.accessToken, 'new');
  });

  test('revocation presents the refresh token with its hint, and being offline is not an error', async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({}));
    assert.equal(await revokeStoredToken(config(), fetchImpl), true);
    assert.equal(calls[0]?.url, METADATA.revocation_endpoint);
    assert.equal(calls[0]?.body?.get('token'), 'rt_old');
    assert.equal(calls[0]?.body?.get('token_type_hint'), 'refresh_token');
    assert.equal(calls[0]?.body?.get('client_id'), 'cli');

    assert.equal(await revokeStoredToken(config({ refreshToken: undefined }), fetchImpl), true);
    assert.equal(calls[1]?.body?.get('token'), 'old-access');
    assert.equal(calls[1]?.body?.get('token_type_hint'), 'access_token');

    const offline: typeof fetch = async () => {
      throw new Error('ENOTFOUND');
    };
    assert.equal(await revokeStoredToken(config(), offline), false);
  });
});

describe('CLI token lifecycle across processes', () => {
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'cli-tokens-lock-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(configHome, { recursive: true, force: true });
  });

  test('two refreshes of the same stored token present it once; the second adopts the first result', async () => {
    const { saveConfig } = await import('./config.ts');
    const stored = config({ expiresAt: Date.now() + 60_000 });
    await saveConfig(stored);

    let refreshes = 0;
    const { fetchImpl } = fakeFetch(() => {
      refreshes += 1;
      return Response.json({
        access_token: `new-${refreshes}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `rt_new_${refreshes}`,
        refresh_token_expires_in: 100,
      });
    });

    // Both hold the same pre-refresh copy, as two processes would.
    const [first, second] = await Promise.all([
      refreshStoredToken(stored, fetchImpl),
      refreshStoredToken(stored, fetchImpl),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(first?.token.accessToken, 'new-1');
    assert.equal(second?.token.accessToken, 'new-1');
    assert.equal(second?.token.refreshToken, 'rt_new_1');
  });

  test('revocation gives up after its timeout instead of holding the logout', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const started = Date.now();
    assert.equal(await revokeStoredToken(config(), hanging, 100), false);
    assert.ok(Date.now() - started < 2_000);
  });
});
