import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { parseArgs } from '../lib/utils.ts';
import type { ToolClient } from '../lib/tool-client.ts';
import { handleCreate } from './create.ts';

type Call = { name: string; args: Record<string, unknown> };

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'image/frame',
    kind: 'image',
    availability: 'available',
    hidden: false,
    params_schema: {
      type: 'object',
      properties: {
        t: { default: 'last', oneOf: [{ type: 'number', minimum: 0 }, { const: 'last' }] },
      },
      additionalProperties: false,
    },
    ...overrides,
  };
}

function frameArgs(t?: string, extra: string[] = []) {
  return parseArgs([
    '--space',
    'acme/flight',
    '--kind',
    'image',
    '--model',
    'image/frame',
    '--ref',
    'as_video:source',
    ...(t ? ['--param', `t=${t}`] : []),
    ...extra,
  ]);
}

function createClient(
  models: Record<string, unknown>[],
  calls: Call[],
  created: Record<string, unknown> = {},
) {
  const client: ToolClient = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'list_models') return { models, credit_eur: 0.01, actions: [] };
      return created;
    },
  };
  return client;
}

async function run(
  parsed = frameArgs(),
  models = [model()],
  created: Record<string, unknown> = {},
): Promise<Call[]> {
  const calls: Call[] = [];
  const client = createClient(models, calls, created);
  await handleCreate(parsed, {
    client: async () => client,
    write: () => undefined,
    id: () => 'request-id',
  });
  return calls;
}

test('rejects unknown create options and positionals before authentication', async () => {
  for (const parsed of [
    parseArgs(['--promt', 'mistyped']),
    parseArgs(['unexpected', '--space', 'acme/flight', '--kind', 'image', '--model', 'image/frame']),
  ]) {
    let requestedClient = false;
    await assert.rejects(
      handleCreate(parsed, {
        client: async () => {
          requestedClient = true;
          throw new Error('Authentication must not be attempted.');
        },
        write: () => undefined,
        id: () => 'request-id',
      }),
      /Usage: makefx create/,
    );
    assert.equal(requestedClient, false);
  }
});

test('uses a newly served model id and applies defaults from its live schema', async () => {
  const parsed = parseArgs([
    '--space',
    'acme/flight',
    '--kind',
    'image',
    '--model',
    'image/server-new',
    '--prompt',
    'A market',
  ]);
  const calls = await run(parsed, [
    model({
      id: 'image/server-new',
      params_schema: {
        type: 'object',
        properties: {
          quality: { enum: ['server-default', 'other'], default: 'server-default' },
        },
        additionalProperties: false,
      },
    }),
  ]);

  assert.deepEqual(
    calls.map(({ name }) => name),
    ['list_models', 'create_asset'],
  );
  assert.deepEqual(calls[0]?.args, { space_id: 'acme/flight' });
  assert.deepEqual(calls[1]?.args, {
    space_id: 'acme/flight',
    kind: 'image',
    model: 'image/server-new',
    prompt: 'A market',
    references: [],
    params: { quality: 'server-default' },
    count: 1,
    tags: [],
    request_id: 'request-id',
  });
});

test('preserves create options after validating them against the live model', async () => {
  const parsed = frameArgs('3.25');
  parsed.options['from-asset'] = 'as_source';
  parsed.options['recipe-mode'] = 'exact';
  parsed.options.name = 'Frame';
  parsed.options['request-id'] = 'caller-id';
  const calls = await run(parsed);

  assert.deepEqual(calls[1]?.args, {
    space_id: 'acme/flight',
    kind: 'image',
    model: 'image/frame',
    prompt: '',
    references: [{ asset_id: 'as_video', slot: 'source', order: 0 }],
    params: { t: 3.25 },
    count: 1,
    recipe_mode: 'exact',
    from_asset_id: 'as_source',
    name: 'Frame',
    tags: [],
    request_id: 'caller-id',
  });
});

test('maps seed, canvas metadata, and repeated references in stable shell order', async () => {
  const parsed = parseArgs([
    '--space',
    'acme/flight',
    '--kind',
    'image',
    '--model',
    'image/frame',
    '--ref',
    'as_first:source',
    '--ref',
    'as_second:reference',
    '--param',
    't=last',
    '--seed',
    '-17',
    '--position',
    '{"x":12.5,"y":-4}',
    '--tags',
    '["hero","approved"]',
    '--note',
    'Keep this frame',
  ]);
  const calls = await run(parsed);

  assert.deepEqual(calls[1]?.args, {
    space_id: 'acme/flight',
    kind: 'image',
    model: 'image/frame',
    prompt: '',
    references: [
      { asset_id: 'as_first', slot: 'source', order: 0 },
      { asset_id: 'as_second', slot: 'reference', order: 1 },
    ],
    params: { t: 'last' },
    count: 1,
    seed: -17,
    position: { x: 12.5, y: -4 },
    tags: ['hero', 'approved'],
    note: 'Keep this frame',
    request_id: 'request-id',
  });
});

test('rejects malformed create metadata before authentication', async () => {
  for (const args of [
    ['--seed', '1.5'],
    ['--seed'],
    ['--seed='],
    ['--seed=   '],
    ['--position', '{"x":1}'],
    ['--position', '{"x":1,"y":2,"z":3}'],
    ['--tags', '["ok",3]'],
  ]) {
    let authenticated = false;
    await assert.rejects(
      handleCreate(
        parseArgs(['--space', 'acme/flight', '--kind', 'image', '--model', 'image/frame', ...args]),
        {
          client: async () => {
            authenticated = true;
            throw new Error('must not authenticate');
          },
          write: () => undefined,
          id: () => 'request-id',
        },
      ),
      /--seed|--position|--tags/,
    );
    assert.equal(authenticated, false);
  }
});

test('keeps preview models usable and allows exact replay when the current model is unavailable', async () => {
  const parsed = frameArgs('last');
  parsed.options['from-asset'] = 'as_source';
  parsed.options['recipe-mode'] = 'exact';
  const calls = await run(parsed, [model({ availability: 'unavailable' })]);

  assert.deepEqual(
    calls.map(({ name }) => name),
    ['list_models', 'create_asset'],
  );
  assert.equal(calls[1]?.args.recipe_mode, 'exact');
  assert.equal(calls[1]?.args.from_asset_id, 'as_source');

  const previewCalls = await run(frameArgs('last'), [model({ availability: 'preview' })]);
  assert.deepEqual(
    previewCalls.map(({ name }) => name),
    ['list_models', 'create_asset'],
  );
});

test('rejects invalid recipe replay options before authentication', async () => {
  for (const extra of [
    ['--recipe-mode', 'newest'],
    ['--recipe-mode', 'exact'],
  ]) {
    let requestedClient = false;
    await assert.rejects(
      handleCreate(
        parseArgs(['--space', 'acme/flight', '--kind', 'image', '--model', 'image/frame', ...extra]),
        {
          client: async () => {
            requestedClient = true;
            throw new Error('Authentication must not be attempted.');
          },
          write: () => undefined,
          id: () => 'request-id',
        },
      ),
      /recipe-mode/,
    );
    assert.equal(requestedClient, false);
  }
});

test('does not create for hidden, unavailable, missing, wrong-kind, or invalid live model input', async () => {
  const cases: Array<{ models: Record<string, unknown>[]; error: RegExp }> = [
    { models: [model({ hidden: true })], error: /Unknown model/ },
    { models: [model({ availability: 'unavailable' })], error: /is unavailable/ },
    { models: [], error: /Unknown model/ },
    { models: [model({ kind: 'video' })], error: /creates video assets/ },
  ];
  for (const item of cases) {
    const calls: Call[] = [];
    const client = createClient(item.models, calls);
    await assert.rejects(
      handleCreate(frameArgs(), {
        client: async () => client,
        write: () => undefined,
        id: () => 'request-id',
      }),
      item.error,
    );
    assert.deepEqual(
      calls.map(({ name }) => name),
      ['list_models'],
    );
  }

  const invalidCalls: Call[] = [];
  const invalidClient = createClient([model()], invalidCalls);
  await assert.rejects(
    handleCreate(frameArgs('middle'), {
      client: async () => invalidClient,
      write: () => undefined,
      id: () => 'request-id',
    }),
    /Invalid --param t/,
  );
  assert.deepEqual(
    invalidCalls.map(({ name }) => name),
    ['list_models'],
  );
});

test("refuses a prompt longer than the model's prompt_max_chars before creating", async () => {
  const seedance = model({ prompt_max_chars: 3 });
  const withPrompt = (prompt: string) => frameArgs(undefined, ['--prompt', prompt]);
  const calls: Call[] = [];
  const client = createClient([seedance], calls);
  await assert.rejects(
    handleCreate(withPrompt('abcd'), { client: async () => client, write: () => undefined, id: () => 'request-id' }),
    /--prompt must be at most 3 characters for model "image\/frame"/,
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ['list_models'],
  );
  // Characters, not UTF-16 units: three emoji fit a three-character limit.
  assert.deepEqual(
    (await run(withPrompt('😀😀😀'), [seedance])).map(({ name }) => name),
    ['list_models', 'create_asset'],
  );
});

test('validates speech voices from the paying Space catalog', async () => {
  const speech = model({
    id: 'audio/eleven-v3',
    kind: 'audio',
    params_schema: {
      type: 'object',
      properties: {
        voice_id: {
          title: 'Voice',
          oneOf: [
            {
              const: 'voice-acme',
              title: 'Acme voice',
              description: 'Warm',
              preview_url: 'https://example.com/voice.mp3',
            },
          ],
        },
      },
      required: ['voice_id'],
      additionalProperties: false,
    },
  });
  const accepted = parseArgs([
    '--space',
    'acme/voice',
    '--kind',
    'audio',
    '--model',
    'audio/eleven-v3',
    '--param',
    'voice_id=voice-acme',
  ]);
  const calls = await run(accepted, [speech]);
  assert.deepEqual(calls[0]?.args, { space_id: 'acme/voice' });
  const create = calls[1];
  assert.ok(create);
  assert.deepEqual((create.args.params as Record<string, unknown>).voice_id, 'voice-acme');

  const stale = parseArgs([
    '--space',
    'acme/voice',
    '--kind',
    'audio',
    '--model',
    'audio/eleven-v3',
    '--param',
    'voice_id=voice-operator',
  ]);
  const rejectedCalls: Call[] = [];
  const client = createClient([speech], rejectedCalls);
  await assert.rejects(
    handleCreate(stale, {
      client: async () => client,
      write: () => undefined,
      id: () => 'request-id',
    }),
    /Invalid --param voice_id/,
  );
  assert.deepEqual(
    rejectedCalls.map(({ name }) => name),
    ['list_models'],
  );
});

test('fails closed when list_models returns malformed output', async () => {
  for (const catalog of [
    {},
    { models: [model()], credit_eur: 0.01 },
    {
      models: [model({ params_schema: { type: 'object', unsupported: true } })],
      credit_eur: 0.01,
      actions: [],
    },
    { models: [model({ availability: 'sometimes' })], credit_eur: 0.01, actions: [] },
  ]) {
    const calls: Call[] = [];
    const client: ToolClient = {
      async call(name, args) {
        calls.push({ name, args });
        return catalog;
      },
    };
    await assert.rejects(
      handleCreate(frameArgs(), {
        client: async () => client,
        write: () => undefined,
        id: () => 'request-id',
      }),
      /malformed catalog/,
    );
    assert.deepEqual(
      calls.map(({ name }) => name),
      ['list_models'],
    );
  }
});

test('authenticates once and waits through the same client after catalog validation', async () => {
  const calls: Call[] = [];
  let clientRequests = 0;
  let reads = 0;
  const client: ToolClient = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'list_models') return { models: [model()], credit_eur: 0.01, actions: [] };
      if (name === 'create_asset') {
        return { assets: [{ asset_id: 'as_frame', web_url: 'https://makefx.app/a/as_frame' }] };
      }
      reads += 1;
      return { asset: { status: reads === 1 ? 'generating' : 'ready' } };
    },
  };
  const output: string[] = [];
  const parsed = frameArgs('last');
  parsed.options.wait = 'true';

  await handleCreate(parsed, {
    client: async () => {
      clientRequests += 1;
      return client;
    },
    write: (text) => output.push(text),
    id: () => 'request-id',
  });

  assert.equal(clientRequests, 1);
  assert.deepEqual(
    calls.map(({ name }) => name),
    ['list_models', 'create_asset', 'get_asset', 'get_asset'],
  );
  assert.deepEqual(output, ['as_frame https://makefx.app/a/as_frame']);
});

test('surfaces an extracted asset failure while waiting', async () => {
  const client: ToolClient = {
    async call(name) {
      if (name === 'list_models') return { models: [model()], credit_eur: 0.01, actions: [] };
      return name === 'create_asset'
        ? { assets: [{ asset_id: 'as_frame' }] }
        : { asset: { status: 'failed', error: { message: 'The source video is unavailable.' } } };
    },
  };

  const parsed = frameArgs('last');
  parsed.options.wait = 'true';
  await assert.rejects(
    handleCreate(parsed, {
      client: async () => client,
      write: () => undefined,
      id: () => 'request-id',
    }),
    /source video is unavailable/,
  );
});

test('waits for every batch asset to finish before reporting failures', async () => {
  const reads: string[] = [];
  let secondReads = 0;
  const client: ToolClient = {
    async call(name, args) {
      if (name === 'list_models') return { models: [model()], credit_eur: 0.01, actions: [] };
      if (name === 'create_asset') {
        return { assets: [{ asset_id: 'as_failed' }, { asset_id: 'as_ready' }] };
      }
      const assetId = String(args.asset_id);
      reads.push(assetId);
      if (assetId === 'as_failed') {
        return { asset: { status: 'failed', error: { message: 'First asset failed.' } } };
      }
      secondReads += 1;
      return { asset: { status: secondReads === 1 ? 'generating' : 'ready' } };
    },
  };
  const parsed = frameArgs('last');
  parsed.options.wait = 'true';

  await assert.rejects(
    handleCreate(parsed, {
      client: async () => client,
      write: () => undefined,
      id: () => 'request-id',
    }),
    /First asset failed/,
  );
  assert.deepEqual(reads, ['as_failed', 'as_ready', 'as_ready']);
});

test('waited success prints the final ready status under --json', async () => {
  let reads = 0;
  const client: ToolClient = {
    async call(name) {
      if (name === 'list_models') return { models: [model()], credit_eur: 0.01, actions: [] };
      if (name === 'create_asset') {
        return {
          assets: [{ asset_id: 'as_frame', web_url: 'https://makefx.app/a/as_frame', status: 'queued' }],
        };
      }
      reads += 1;
      return { asset: { status: reads === 1 ? 'generating' : 'ready' } };
    },
  };
  const output: string[] = [];
  const parsed = frameArgs('last');
  parsed.options.wait = 'true';
  parsed.options.json = 'true';

  await handleCreate(parsed, {
    client: async () => client,
    write: (text) => output.push(text),
    id: () => 'request-id',
  });

  const printed = JSON.parse(output[0] ?? '{}');
  assert.deepEqual(printed.assets, [
    { asset_id: 'as_frame', web_url: 'https://makefx.app/a/as_frame', status: 'ready' },
  ]);
});

test('waited failure under --json prints the refreshed envelope with the error and exits 1', async () => {
  const client: ToolClient = {
    async call(name) {
      if (name === 'list_models') return { models: [model()], credit_eur: 0.01, actions: [] };
      if (name === 'create_asset') {
        return { assets: [{ asset_id: 'as_frame', web_url: 'https://makefx.app/a/as_frame' }] };
      }
      return {
        asset: { status: 'failed', error: { code: 'provider_failure', message: 'The source video is unavailable.' } },
      };
    },
  };
  const output: string[] = [];
  const parsed = frameArgs('last');
  parsed.options.wait = 'true';
  parsed.options.json = 'true';
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await handleCreate(parsed, {
      client: async () => client,
      write: (text) => output.push(text),
      id: () => 'request-id',
    });

    assert.equal(process.exitCode, 1);
    const printed = JSON.parse(output[0] ?? '{}');
    assert.equal(printed.assets[0].asset_id, 'as_frame');
    assert.equal(printed.assets[0].status, 'failed');
    assert.equal(printed.assets[0].error.code, 'provider_failure');
  } finally {
    process.exitCode = previousExitCode;
  }
});
