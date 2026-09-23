import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolCallError } from '../lib/errors.ts';
import type { ToolClient } from '../lib/tool-client.ts';
import { parseArgs } from '../lib/utils.ts';
import { commandUsage, dataToolCall, handleDataCommand, type DataCommand } from './read.ts';

test('maps account, list, model, and nested commands to their public MCP tools', () => {
  assert.deepEqual(dataToolCall('account', parseArgs(['--account', 'acme'])), {
    name: 'get_account',
    args: { account_id: 'acme' },
  });
  assert.deepEqual(dataToolCall('spaces', parseArgs(['--query', 'salt', '--limit', '12'])), {
    name: 'list_spaces',
    args: { query: 'salt', limit: 12 },
  });
  assert.deepEqual(dataToolCall('spaces', parseArgs(['--account', 'acme'])), {
    name: 'list_spaces',
    args: { account_id: 'acme' },
  });
  assert.deepEqual(
    dataToolCall('space create', parseArgs(['--account', 'acme', '--name', 'Salt', '--id', 'salt'])),
    {
      name: 'create_space',
      args: { account_id: 'acme', name: 'Salt', space_id: 'salt' },
    },
  );
  assert.deepEqual(dataToolCall('space get', parseArgs(['--space', 'acme/salt', '--starred-only'])), {
    name: 'get_space',
    args: { space_id: 'acme/salt', starred_only: true },
  });
  assert.deepEqual(dataToolCall('space delete', parseArgs(['--space', 'acme/salt'])), {
    name: 'delete_space',
    args: { space_id: 'acme/salt' },
  });
  assert.deepEqual(
    dataToolCall('models', parseArgs(['--space', 'acme/salt', '--kind', 'video', '--family', 'provider'])),
    {
      name: 'list_models',
      args: { space_id: 'acme/salt', kind: 'video', family: 'provider' },
    },
  );
  assert.deepEqual(dataToolCall('models', parseArgs([])), { name: 'list_models', args: {} });
  assert.deepEqual(dataToolCall('profile get', parseArgs([])), { name: 'get_profile', args: {} });
  assert.deepEqual(dataToolCall('health', parseArgs([])), { name: 'health_check', args: {} });
  assert.deepEqual(
    dataToolCall(
      'asset get',
      parseArgs(['--space', 'acme/salt', '--asset', 'as_one', '--wait-seconds', '30']),
    ),
    {
      name: 'get_asset',
      args: { space_id: 'acme/salt', asset_id: 'as_one', wait_seconds: 30 },
    },
  );
});

test('maps estimate values without making a catalog or transport call', () => {
  assert.deepEqual(
    dataToolCall(
      'estimate',
      parseArgs([
        '--space',
        'acme/salt',
        '--kind',
        'video',
        '--model',
        'video/h3-max',
        '--prompt',
        'Fly over the harbor',
        '--ref',
        'as_one:start_frame',
        '--param',
        'duration_seconds=8',
        '--param',
        'settings={"resolution":"1080p"}',
        '--count',
        '2',
        '--from-asset',
        'as_source',
        '--recipe-mode',
        'exact',
      ]),
    ),
    {
      name: 'estimate_credits',
      args: {
        space_id: 'acme/salt',
        kind: 'video',
        model: 'video/h3-max',
        prompt: 'Fly over the harbor',
        references: [{ asset_id: 'as_one', slot: 'start_frame' }],
        params: { duration_seconds: 8, settings: { resolution: '1080p' } },
        count: 2,
        from_asset_id: 'as_source',
        recipe_mode: 'exact',
      },
    },
  );
  assert.deepEqual(
    dataToolCall(
      'estimate',
      parseArgs([
        '--kind',
        'image',
        '--model',
        'image/gemini-3-pro-image',
        '--from-asset',
        'as_source',
        '--recipe-mode',
        'current',
      ]),
    ),
    {
      name: 'estimate_credits',
      args: {
        kind: 'image',
        model: 'image/gemini-3-pro-image',
        prompt: '',
        references: [],
        params: {},
        count: 1,
        from_asset_id: 'as_source',
        recipe_mode: 'current',
      },
    },
  );
  assert.match(commandUsage('estimate'), /--from-asset ASSET.*--recipe-mode current\|exact/);
});

test('each handler authenticates once, calls exactly one tool, and preserves environment options', async () => {
  const commands: Array<[DataCommand, string[], string]> = [
    ['account', [], 'get_account'],
    ['spaces', [], 'list_spaces'],
    ['space create', ['--name', 'Salt'], 'create_space'],
    ['space get', ['--space', 'acme/salt'], 'get_space'],
    ['space delete', ['--space', 'acme/salt'], 'delete_space'],
    ['models', [], 'list_models'],
    ['profile get', [], 'get_profile'],
    ['health', [], 'health_check'],
    ['estimate', ['--kind', 'image', '--model', 'image/gemini-3-pro-image'], 'estimate_credits'],
    ['asset get', ['--space', 'acme/salt', '--asset', 'as_one'], 'get_asset'],
  ];

  for (const [command, args, tool] of commands) {
    const calls: string[] = [];
    let clientRequests = 0;
    const parsed = parseArgs([...args, '--env', 'stage', '--json']);
    await handleDataCommand(command, parsed, {
      client: async (received) => {
        clientRequests += 1;
        assert.equal(received.options.env, 'stage');
        return { call: async (name) => (calls.push(name), { ok: true }) };
      },
      write: () => undefined,
    });
    assert.equal(clientRequests, 1);
    assert.deepEqual(calls, [tool]);
  }

  await handleDataCommand('account', parseArgs(['--local']), {
    client: async (received) => {
      assert.equal(received.options.local, 'true');
      return { call: async () => ({ account_id: 'local', balance_credits: 0, held_credits: 0 }) };
    },
    write: () => undefined,
  });
});

test('prints concise human output and unchanged structured JSON', async () => {
  const result = {
    spaces: [
      { space_id: 'acme/one', web_url: 'https://makefx.app/s/acme/one' },
      { space_id: 'acme/two', web_url: 'https://makefx.app/s/acme/two' },
    ],
  };
  const client: ToolClient = { call: async () => result };
  const human: string[] = [];
  await handleDataCommand('spaces', parseArgs([]), {
    client: async () => client,
    write: (text) => human.push(text),
  });
  assert.deepEqual(human, [
    'acme/one https://makefx.app/s/acme/one',
    'acme/two https://makefx.app/s/acme/two',
  ]);

  const json: string[] = [];
  await handleDataCommand('spaces', parseArgs(['--json']), {
    client: async () => client,
    write: (text) => json.push(text),
  });
  assert.deepEqual(JSON.parse(json[0] ?? ''), result);

  const models: string[] = [];
  await handleDataCommand('models', parseArgs([]), {
    client: async () => ({
      call: async () => ({
        models: [
          {
            id: 'image/flash',
            label: 'Nano Banana 2',
            provider: 'google_ai',
            provider_model: 'gemini-3.1-flash-image',
            provider_model_kind: 'alias',
            hidden: true,
          },
          {
            id: 'image/gemini-3.1-flash-image',
            label: 'Nano Banana 2',
            provider: 'google_ai',
            provider_model: 'gemini-3.1-flash-image',
            provider_model_kind: 'alias',
            hidden: false,
          },
        ],
      }),
    }),
    write: (text) => models.push(text),
  });
  assert.deepEqual(models, [
    'Nano Banana 2 · gemini-3.1-flash-image · google_ai · alias · image/gemini-3.1-flash-image',
  ]);

  const summaries: Array<[DataCommand, Record<string, unknown>, string]> = [
    [
      'profile get',
      { id: 'usr_one', email: 'ada@example.com', name: 'Ada Example' },
      'usr_one · ada@example.com · Ada Example',
    ],
    ['health', { status: 'ok', environment: 'stage' }, 'ok · stage'],
  ];
  for (const [command, value, expected] of summaries) {
    const output: string[] = [];
    await handleDataCommand(command, parseArgs([]), {
      client: async () => ({ call: async () => value }),
      write: (text) => output.push(text),
    });
    assert.deepEqual(output, [expected]);
  }
});

test('rejects invalid usage before authentication', async () => {
  let requestedClient = false;
  await assert.rejects(
    handleDataCommand('asset get', parseArgs(['--space', 'acme/one', '--wat', 'no']), {
      client: async () => {
        requestedClient = true;
        throw new Error('must not authenticate');
      },
      write: () => undefined,
    }),
    /Unknown option --wat.*Usage: makefx asset get/,
  );
  assert.equal(requestedClient, false);
  assert.throws(() => dataToolCall('models', parseArgs(['--kind', 'text'])), /image, video, or audio/);
  assert.throws(
    () => dataToolCall('models', parseArgs(['--family', 'legacy'])),
    /provider, internal, or browser/,
  );
  assert.throws(
    () => dataToolCall('estimate', parseArgs(['--kind', 'text', '--model', 'text/one'])),
    /image, video, or audio/,
  );
  assert.throws(
    () =>
      dataToolCall(
        'estimate',
        parseArgs(['--kind', 'image', '--model', 'image/gemini-3-pro-image', '--recipe-mode', 'next']),
      ),
    /--recipe-mode must be current or exact/,
  );
  assert.throws(
    () =>
      dataToolCall(
        'estimate',
        parseArgs(['--kind', 'image', '--model', 'image/gemini-3-pro-image', '--recipe-mode', 'exact']),
      ),
    /--recipe-mode exact requires --from-asset/,
  );
  assert.throws(() => dataToolCall('spaces', parseArgs(['--limit', '0'])), /integer from 1 to 100/);
});

test('surfaces tool failures without a second call', async () => {
  let calls = 0;
  const failure = new ToolCallError(
    { code: 'not_found', message: 'Space not found.', retryable: false },
    'failed',
  );
  await assert.rejects(
    handleDataCommand('space get', parseArgs(['--space', 'acme/missing']), {
      client: async () => ({
        call: async () => {
          calls += 1;
          throw failure;
        },
      }),
      write: () => undefined,
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});
