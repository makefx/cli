import assert from 'node:assert/strict';
import test from 'node:test';
import { reportCommandError } from '../lib/command-error.ts';
import type { StoredConfig } from '../lib/types.ts';
import { parseArgs } from '../lib/utils.ts';
import { handleSpaceVisibilityCommand } from './space-visibility.ts';

function config(): StoredConfig {
  return {
    environment: 'stage',
    baseUrl: 'https://stage.example.com',
    clientId: 'cli',
    token: { accessToken: 'person-token', issuedAt: 1, expiresAt: 2 },
    user: null,
    updatedAt: '2026-09-15T12:00:00.000Z',
  };
}

const space = {
  space_id: 'acme/salt',
  account_id: 'acme',
  role: 'owner' as const,
  name: 'Salt Harbour',
  asset_count: 2,
  is_public: true,
  created_at: '2026-09-15T10:00:00.000Z',
  updated_at: '2026-09-15T12:00:00.000Z',
  web_url: 'https://makefx.app/s/acme/salt',
};

test('publish and unpublish PATCH visibility through REST with the person token', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const output: string[] = [];
  let authenticated = 0;
  const dependencies = {
    authenticate: async () => {
      authenticated += 1;
      return config();
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
      const body = init?.body;
      assert.equal(typeof body, 'string');
      if (typeof body !== 'string') throw new Error('Expected a JSON request body');
      const isPublic = JSON.parse(body).is_public as boolean;
      return Response.json({ space: { ...space, is_public: isPublic } });
    }) as typeof fetch,
    write: (text: string) => output.push(text),
  };

  await handleSpaceVisibilityCommand(
    'space publish',
    parseArgs(['--space', 'acme/salt', '--env', 'stage']),
    dependencies,
  );
  await handleSpaceVisibilityCommand(
    'space unpublish',
    parseArgs(['--space', 'acme/salt', '--env', 'stage', '--json']),
    dependencies,
  );

  assert.equal(authenticated, 2);
  assert.deepEqual(
    calls.map(({ url, init }) => {
      const body = init?.body;
      assert.equal(typeof body, 'string');
      if (!init || typeof body !== 'string') throw new Error('Expected a JSON request body');
      return {
        url,
        method: init.method,
        authorization: new Headers(init.headers).get('Authorization'),
        body: JSON.parse(body),
      };
    }),
    [
      {
        url: 'https://stage.example.com/api/spaces/acme/salt',
        method: 'PATCH',
        authorization: 'Bearer person-token',
        body: { is_public: true },
      },
      {
        url: 'https://stage.example.com/api/spaces/acme/salt',
        method: 'PATCH',
        authorization: 'Bearer person-token',
        body: { is_public: false },
      },
    ],
  );
  assert.equal(output[0], 'acme/salt · public · https://makefx.app/s/acme/salt');
  assert.equal(JSON.parse(output[1] ?? '').space.is_public, false);
});

test('an owner-only refusal is reported without claiming the space changed', async () => {
  const output: string[] = [];
  await assert.rejects(
    handleSpaceVisibilityCommand('space publish', parseArgs(['--space', 'acme/salt']), {
      authenticate: async () => config(),
      fetch: (async () =>
        Response.json(
          { error: 'forbidden', error_description: 'Only an account owner can publish' },
          { status: 403 },
        )) as typeof fetch,
      write: (text) => output.push(text),
    }),
    (error: unknown) => {
      assert.equal((error as Error).message, 'Only an account owner can publish');
      return true;
    },
  );
  assert.deepEqual(output, []);
});

test('REST errors preserve explicit retryability and derive transient statuses', async () => {
  for (const [status, payload, retryable] of [
    [400, { error: 'retry_requested', retryable: true }, true],
    [429, { error: 'rate_limited' }, true],
    [503, { error: 'unavailable' }, true],
    [503, { error: 'settled_failure', retryable: false }, false],
  ] as const) {
    await assert.rejects(
      handleSpaceVisibilityCommand('space publish', parseArgs(['--space', 'acme/salt']), {
        authenticate: async () => config(),
        fetch: (async () => Response.json(payload, { status })) as typeof fetch,
        write: () => undefined,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { structuredContent?: { retryable?: unknown } }).structuredContent?.retryable,
          retryable,
        );
        return true;
      },
      `${status} ${payload.error}`,
    );
  }
});

test('JSON errors retain the original REST payload for refusals and throttles', async () => {
  for (const [status, payload] of [
    [403, { error: 'forbidden', error_description: 'Only an account owner can publish' }],
    [429, { error: 'rate_limited', error_description: 'Retry after the named interval' }],
  ] as const) {
    let caught: unknown;
    try {
      await handleSpaceVisibilityCommand('space publish', parseArgs(['--space', 'acme/salt', '--json']), {
        authenticate: async () => config(),
        fetch: (async () => Response.json(payload, { status })) as typeof fetch,
        write: () => undefined,
      });
    } catch (error) {
      caught = error;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    assert.equal(
      reportCommandError(caught, true, {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }),
      1,
    );
    assert.deepEqual(JSON.parse(stdout.join('')), payload);
    assert.match(stderr.join(''), new RegExp(`^${payload.error}:`));
  }
});

test('rejected-token JSON errors retain the REST payload and sign-in hint', async () => {
  const payload = { error: 'invalid_token', error_description: 'The access token was rejected' };
  for (const command of ['space publish', 'space unpublish'] as const) {
    let caught: unknown;
    try {
      await handleSpaceVisibilityCommand(command, parseArgs(['--space', 'acme/salt', '--json']), {
        authenticate: async () => config(),
        fetch: (async () => Response.json(payload, { status: 401 })) as typeof fetch,
        write: () => undefined,
      });
    } catch (error) {
      caught = error;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    assert.equal(
      reportCommandError(caught, true, {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }),
      1,
    );
    assert.deepEqual(JSON.parse(stdout.join('')), payload);
    assert.deepEqual(stderr, ['invalid_token: The stored login was rejected. Sign in again.\n']);
  }
});

test('invalid visibility command input is rejected before authentication', async () => {
  let authenticated = false;
  await assert.rejects(
    handleSpaceVisibilityCommand('space publish', parseArgs(['--space', 'salt']), {
      authenticate: async () => {
        authenticated = true;
        return config();
      },
      fetch,
      write: () => undefined,
    }),
    /ACCOUNT\/SPACE/,
  );
  assert.equal(authenticated, false);
});
