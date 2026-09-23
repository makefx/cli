import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolCallError } from '../lib/errors.ts';
import type { ToolClient } from '../lib/tool-client.ts';
import { parseArgs } from '../lib/utils.ts';
import { handleMutationCommand, mutationToolCall, type MutationCommand } from './mutate.ts';

test('maps asset mutation and relationship arguments to their MCP tools', () => {
  assert.deepEqual(mutationToolCall('voices sync', parseArgs(['--account', 'acme'])), {
    name: 'sync_voices',
    args: { account_id: 'acme' },
  });
  assert.deepEqual(mutationToolCall('profile update', parseArgs(['--name', 'Ada Example'])), {
    name: 'update_profile',
    args: { name: 'Ada Example' },
  });
  assert.deepEqual(
    mutationToolCall('space update', parseArgs(['--space', 'acme/salt', '--name', 'Salt Harbour'])),
    { name: 'update_space', args: { space_id: 'acme/salt', name: 'Salt Harbour' } },
  );
  assert.throws(
    () => mutationToolCall('space update', parseArgs(['--space', 'acme/salt', '--name', '   '])),
    /non-empty --name/,
  );
  assert.throws(
    () => mutationToolCall('space update', parseArgs(['--space', 'acme/salt'])),
    /requires --name/,
  );
  assert.deepEqual(
    mutationToolCall(
      'asset update',
      parseArgs([
        '--space',
        'acme/salt',
        '--asset',
        'as_one',
        '--name',
        'Harbor',
        '--note',
        'At dawn',
        '--traits',
        'soft grey light',
        '--tags',
        '["harbor","dawn"]',
        '--starred',
        'false',
        '--position',
        '{"x":12,"y":24}',
        '--recipe',
        '{"provider":"external","model":"camera","prompt":"","params":{},"references":[]}',
      ]),
    ),
    {
      name: 'update_asset',
      args: {
        space_id: 'acme/salt',
        asset_id: 'as_one',
        name: 'Harbor',
        note: 'At dawn',
        traits: 'soft grey light',
        tags: ['harbor', 'dawn'],
        starred: false,
        position: { x: 12, y: 24 },
        recipe: { provider: 'external', model: 'camera', prompt: '', params: {}, references: [] },
      },
    },
  );
  assert.deepEqual(
    mutationToolCall('asset delete', parseArgs(['--space', 'acme/salt', '--asset', 'as_one'])),
    { name: 'delete_asset', args: { space_id: 'acme/salt', asset_id: 'as_one' } },
  );
  assert.deepEqual(
    mutationToolCall(
      'link',
      parseArgs(['--space', 'acme/salt', '--from', 'as_one', '--to', 'as_two', '--label', 'Next']),
    ),
    {
      name: 'link_assets',
      args: { space_id: 'acme/salt', from_asset_id: 'as_one', to_asset_id: 'as_two', label: 'Next' },
    },
  );
  assert.deepEqual(mutationToolCall('unlink', parseArgs(['--space', 'acme/salt', '--link', 'ln_one'])), {
    name: 'unlink_assets',
    args: { space_id: 'acme/salt', link_id: 'ln_one' },
  });
  assert.deepEqual(
    mutationToolCall(
      'unlink',
      parseArgs(['--space', 'acme/salt', '--from', 'as_one', '--to', 'as_two', '--label', 'Next']),
    ),
    {
      name: 'unlink_assets',
      args: { space_id: 'acme/salt', from_asset_id: 'as_one', to_asset_id: 'as_two', label: 'Next' },
    },
  );
});

test('asset update preserves omitted fields and maps explicit clearing', () => {
  assert.deepEqual(
    mutationToolCall(
      'asset update',
      parseArgs([
        '--space',
        'acme/salt',
        '--asset',
        'as_one',
        '--note',
        'null',
        '--traits=null',
        '--tags',
        '[]',
      ]),
    ),
    {
      name: 'update_asset',
      args: { space_id: 'acme/salt', asset_id: 'as_one', note: null, traits: null, tags: [] },
    },
  );
});

test('describe preserves a caller request id and creates one only when omitted', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let generated = 0;
  const client: ToolClient = {
    async call(name, args) {
      calls.push({ name, args });
      return { asset_id: 'as_one', web_url: 'https://makefx.app/s/acme/salt/a/as_one' };
    },
  };
  const dependencies = {
    client: async () => client,
    write: () => undefined,
    id: () => ((generated += 1), 'generated-once'),
  };

  await handleMutationCommand(
    'describe',
    parseArgs(['--space', 'acme/salt', '--asset', 'as_one', '--request-id', 'caller-id']),
    dependencies,
  );
  await handleMutationCommand(
    'describe',
    parseArgs(['--space', 'acme/salt', '--asset', 'as_one']),
    dependencies,
  );

  assert.equal(generated, 1);
  assert.deepEqual(calls, [
    { name: 'describe_asset', args: { space_id: 'acme/salt', asset_id: 'as_one', request_id: 'caller-id' } },
    {
      name: 'describe_asset',
      args: { space_id: 'acme/salt', asset_id: 'as_one', request_id: 'generated-once' },
    },
  ]);
});

test('each command authenticates once and calls only its mutation tool', async () => {
  const commands: Array<[MutationCommand, string[], string]> = [
    ['voices sync', ['--account', 'acme'], 'sync_voices'],
    ['profile update', ['--name', 'Ada Example'], 'update_profile'],
    ['space update', ['--space', 'acme/salt', '--name', 'Salt Harbour'], 'update_space'],
    ['asset update', ['--space', 'acme/salt', '--asset', 'as_one', '--name', 'One'], 'update_asset'],
    ['asset delete', ['--space', 'acme/salt', '--asset', 'as_one'], 'delete_asset'],
    ['describe', ['--space', 'acme/salt', '--asset', 'as_one'], 'describe_asset'],
    ['link', ['--space', 'acme/salt', '--from', 'as_one', '--to', 'as_two'], 'link_assets'],
    ['unlink', ['--space', 'acme/salt', '--link', 'ln_one'], 'unlink_assets'],
  ];

  for (const [command, args, expectedTool] of commands) {
    const tools: string[] = [];
    let authenticated = 0;
    await handleMutationCommand(command, parseArgs([...args, '--env', 'stage', '--json']), {
      client: async (parsed) => {
        authenticated += 1;
        assert.equal(parsed.options.env, 'stage');
        return { call: async (name) => (tools.push(name), { ok: true }) };
      },
      write: () => undefined,
      id: () => 'request-one',
    });
    assert.equal(authenticated, 1);
    assert.deepEqual(tools, [expectedTool]);
  }
});

test('prints affected ids and URLs, and leaves structured JSON unchanged', async () => {
  const cases: Array<[MutationCommand, string[], Record<string, unknown>, string]> = [
    [
      'voices sync',
      ['--account', 'acme'],
      {
        account_id: 'acme',
        provider: 'elevenlabs',
        active_voice_count: 3,
        synced_at: Date.parse('2026-09-13T12:00:00.000Z'),
      },
      'acme · 3 active voices · synced 2026-09-13T12:00:00.000Z',
    ],
    [
      'profile update',
      ['--name', 'Ada Example'],
      { success: true, user: { id: 'usr_one', email: 'ada@example.com', name: 'Ada Example' } },
      'usr_one · ada@example.com · Ada Example',
    ],
    [
      'space update',
      ['--space', 'acme/salt', '--name', 'Salt Harbour'],
      {
        space: {
          space_id: 'acme/salt',
          name: 'Salt Harbour',
          is_public: true,
          web_url: 'https://makefx.app/s/acme/salt',
        },
      },
      'acme/salt · Salt Harbour · public · https://makefx.app/s/acme/salt',
    ],
    [
      'asset update',
      ['--space', 'acme/salt', '--asset', 'as_one', '--name', 'One'],
      { asset: { asset_id: 'as_one', web_url: 'https://makefx.app/s/acme/salt/a/as_one' } },
      'as_one https://makefx.app/s/acme/salt/a/as_one',
    ],
    [
      'asset delete',
      ['--space', 'acme/salt', '--asset', 'as_one'],
      { ok: true, asset_id: 'as_one' },
      'Deleted as_one',
    ],
    [
      'describe',
      ['--space', 'acme/salt', '--asset', 'as_one'],
      { asset_id: 'as_one', web_url: 'https://makefx.app/s/acme/salt/a/as_one' },
      'as_one https://makefx.app/s/acme/salt/a/as_one',
    ],
    [
      'link',
      ['--space', 'acme/salt', '--from', 'as_one', '--to', 'as_two'],
      { link: { link_id: 'ln_one', from_asset_id: 'as_one', to_asset_id: 'as_two' } },
      'ln_one as_one -> as_two',
    ],
    ['unlink', ['--space', 'acme/salt', '--link', 'ln_one'], { ok: true }, 'Unlinked ln_one'],
  ];

  for (const [command, args, result, expected] of cases) {
    const human: string[] = [];
    await handleMutationCommand(command, parseArgs(args), {
      client: async () => ({ call: async () => result }),
      write: (text) => human.push(text),
      id: () => 'request-one',
    });
    assert.deepEqual(human, [expected]);

    const json: string[] = [];
    await handleMutationCommand(command, parseArgs([...args, '--json']), {
      client: async () => ({ call: async () => result }),
      write: (text) => json.push(text),
      id: () => 'request-one',
    });
    assert.deepEqual(JSON.parse(json[0] ?? ''), result);
  }
});

test('rejects invalid selectors and JSON before authentication', async () => {
  let authenticated = false;
  await assert.rejects(
    handleMutationCommand(
      'asset update',
      parseArgs(['--space', 'acme/salt', '--asset', 'as_one', '--tags', '["one",2]']),
      {
        client: async () => ((authenticated = true), Promise.reject(new Error('must not authenticate'))),
        write: () => undefined,
        id: () => 'request-one',
      },
    ),
    /--tags must be a JSON array of strings/,
  );
  assert.equal(authenticated, false);
  assert.throws(() => mutationToolCall('voices sync', parseArgs([])), /requires --account/);
  assert.throws(
    () =>
      mutationToolCall(
        'unlink',
        parseArgs(['--space', 'acme/salt', '--link', 'ln_one', '--from', 'as_one', '--to', 'as_two']),
      ),
    /accepts --link or --from\/--to, not both/,
  );
});

test('preserves sanitized insufficient-credit failures for the shared reporter', async () => {
  const failure = new ToolCallError(
    {
      code: 'insufficient_credits',
      message: 'This request needs 2 credits; the balance is 0.',
      retryable: false,
      details: { topup_url: 'https://makefx.app/topup?account_id=acme' },
    },
    'failed',
  );
  let calls = 0;
  await assert.rejects(
    handleMutationCommand('describe', parseArgs(['--space', 'acme/salt', '--asset', 'as_one']), {
      client: async () => ({ call: async () => ((calls += 1), Promise.reject(failure)) }),
      write: () => undefined,
      id: () => 'same-request-id',
    }),
    (error) =>
      error instanceof ToolCallError &&
      error === failure &&
      error.details?.topup_url === 'https://makefx.app/topup?account_id=acme',
  );
  assert.equal(calls, 1);
});
