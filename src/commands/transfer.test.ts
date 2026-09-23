import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ToolClient } from '../lib/tool-client.ts';
import { parseArgs } from '../lib/utils.ts';
import { handleTransferCommand, uploadToolArguments } from './transfer.ts';

const signedUpload = {
  asset_id: 'as_upload',
  upload_url: 'https://upload.example/signed',
  method: 'PUT',
  headers: { 'content-type': 'image/png', 'content-length': '131072' },
  expires_at: '2026-09-12T12:00:00Z',
  web_url: 'https://makefx.app/s/acme/salt/a/as_upload',
};

function forbidWholeBody(response: Response): Response {
  response.arrayBuffer = () => Promise.reject(new Error('arrayBuffer must not be called'));
  response.blob = () => Promise.reject(new Error('blob must not be called'));
  response.bytes = () => Promise.reject(new Error('bytes must not be called'));
  response.json = () => Promise.reject(new Error('json must not be called'));
  response.text = () => Promise.reject(new Error('text must not be called'));
  return response;
}

test('maps upload metadata and declared recipe fields to upload_asset', () => {
  const parsed = parseArgs([
    '--space',
    'acme/salt',
    '--kind',
    'image',
    '--file',
    '/tmp/location.png',
    '--name',
    'Location',
    '--provider',
    'external',
    '--model',
    'camera',
    '--prompt',
    'Original frame',
    '--param',
    'lens=35',
    '--param',
    'settings={"flash":false}',
    '--ref',
    'as_board:source',
    '--external-run-id',
    'camera-42',
    '--position',
    '{"x":12,"y":24}',
    '--tags',
    '["reference"]',
    '--request-id',
    'upload-one',
  ]);

  assert.deepEqual(uploadToolArguments(parsed, { path: '/tmp/location.png', size: 42 }), {
    space_id: 'acme/salt',
    kind: 'image',
    filename: 'location.png',
    mime: 'image/png',
    size_bytes: 42,
    name: 'Location',
    recipe: {
      provider: 'external',
      model: 'camera',
      prompt: 'Original frame',
      params: { lens: 35, settings: { flash: false } },
      references: [{ asset_id: 'as_board', slot: 'source', order: 0 }],
      external_run_id: 'camera-42',
    },
    position: { x: 12, y: 24 },
    tags: ['reference'],
    request_id: 'upload-one',
  });
});

test('uploads a bounded file stream once with the exact signed headers and unchanged JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-upload-'));
  try {
    const source = join(directory, 'fixture.png');
    await writeFile(source, Buffer.alloc(131_072, 7));
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let largestChunk = 0;
    let transferred = 0;
    const client: ToolClient = {
      async call(name, args) {
        calls.push({ name, args });
        return signedUpload;
      },
    };
    const output: string[] = [];

    await handleTransferCommand(
      'upload',
      parseArgs(['--space', 'acme/salt', '--kind', 'image', '--file', source, '--json']),
      {
        client: async () => client,
        fetch: (async (url, init) => {
          assert.equal(url, signedUpload.upload_url);
          assert.equal(init?.method, 'PUT');
          assert.deepEqual(init?.headers, signedUpload.headers);
          assert.ok(init?.body);
          for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
            largestChunk = Math.max(largestChunk, chunk.byteLength);
            transferred += chunk.byteLength;
          }
          return forbidWholeBody(new Response(null, { status: 200 }));
        }) as typeof fetch,
        write: (text) => output.push(text),
        id: () => 'unused',
      },
    );

    assert.equal(transferred, 131_072);
    assert.ok(largestChunk < transferred);
    assert.deepEqual(
      calls.map(({ name }) => name),
      ['upload_asset'],
    );
    assert.equal(calls[0]?.args.size_bytes, 131_072);
    assert.deepEqual(JSON.parse(output[0] ?? ''), signedUpload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('downloads bounded chunks through a sibling temporary file and preserves get_asset JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-download-'));
  try {
    const destination = join(directory, 'result.png');
    const result = {
      asset: {
        asset_id: 'as_ready',
        status: 'ready',
        media_url: 'https://media.example/signed',
        media: { mime: 'image/png', size_bytes: 6 },
        web_url: 'https://makefx.app/s/acme/salt/a/as_ready',
      },
      web_url: 'https://makefx.app/s/acme/salt/a/as_ready',
    };
    const calls: string[] = [];
    const output: string[] = [];
    await handleTransferCommand(
      'download',
      parseArgs(['as_ready', '--space', 'acme/salt', '--out', destination, '--json']),
      {
        client: async () => ({
          async call(name, args) {
            calls.push(name);
            assert.deepEqual(args, { space_id: 'acme/salt', asset_id: 'as_ready', wait_seconds: 0 });
            return result;
          },
        }),
        fetch: (async () =>
          forbidWholeBody(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Uint8Array.from([1, 2, 3]));
                  controller.enqueue(Uint8Array.from([4, 5, 6]));
                  controller.close();
                },
              }),
              { headers: { 'content-length': '6', 'content-type': 'image/png' } },
            ),
          )) as typeof fetch,
        write: (text) => output.push(text),
        id: () => 'temporary',
      },
    );

    assert.deepEqual(calls, ['get_asset']);
    assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3, 4, 5, 6]));
    assert.deepEqual(await readdir(directory), ['result.png']);
    assert.deepEqual(JSON.parse(output[0] ?? ''), result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleans up a premature download and leaves no partial destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-download-short-'));
  try {
    const destination = join(directory, 'result.mp4');
    await assert.rejects(
      handleTransferCommand(
        'download',
        parseArgs(['as_ready', '--space', 'acme/salt', '--out', destination]),
        {
          client: async () => ({
            call: async () => ({
              asset: {
                asset_id: 'as_ready',
                status: 'ready',
                media_url: 'https://media.example/signed',
                media: { mime: 'video/mp4', size_bytes: 8 },
              },
            }),
          }),
          fetch: (async () =>
            forbidWholeBody(
              new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }),
            )) as typeof fetch,
          write: () => undefined,
          id: () => 'temporary',
        },
      ),
      /ended after 3 of 8 bytes/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses to overwrite a destination before fetching media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-download-existing-'));
  try {
    const destination = join(directory, 'keep.png');
    await writeFile(destination, 'keep');
    let fetched = false;
    await assert.rejects(
      handleTransferCommand(
        'download',
        parseArgs(['as_ready', '--space', 'acme/salt', '--out', destination]),
        {
          client: async () => ({
            call: async () => ({
              asset: {
                asset_id: 'as_ready',
                status: 'ready',
                media_url: 'https://media.example/signed',
                media: { mime: 'image/png', size_bytes: 4 },
              },
            }),
          }),
          fetch: (async () => {
            fetched = true;
            return new Response('new');
          }) as typeof fetch,
          write: () => undefined,
          id: () => 'temporary',
        },
      ),
      /Destination already exists/,
    );
    assert.equal(fetched, false);
    assert.equal(await readFile(destination, 'utf8'), 'keep');
    assert.deepEqual(await readdir(directory), ['keep.png']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not overwrite a destination created while media is streaming', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-download-race-'));
  try {
    const destination = join(directory, 'winner.png');
    await assert.rejects(
      handleTransferCommand(
        'download',
        parseArgs(['as_ready', '--space', 'acme/salt', '--out', destination]),
        {
          client: async () => ({
            call: async () => ({
              asset: {
                asset_id: 'as_ready',
                status: 'ready',
                media_url: 'https://media.example/signed',
                media: { mime: 'image/png', size_bytes: 4 },
              },
            }),
          }),
          fetch: (async () => {
            await writeFile(destination, 'winner');
            return forbidWholeBody(
              new Response(Uint8Array.from([1, 2, 3, 4]), { headers: { 'content-length': '4' } }),
            );
          }) as typeof fetch,
          write: () => undefined,
          id: () => 'temporary',
        },
      ),
      (error) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    );
    assert.equal(await readFile(destination, 'utf8'), 'winner');
    assert.deepEqual(await readdir(directory), ['winner.png']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('treats non-success transfer responses and unusable asset states as failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-transfer-failure-'));
  try {
    const source = join(directory, 'fixture.png');
    await writeFile(source, Buffer.alloc(131_072));
    await assert.rejects(
      handleTransferCommand(
        'upload',
        parseArgs(['--space', 'acme/salt', '--kind', 'image', '--file', source]),
        {
          client: async () => ({ call: async () => signedUpload }),
          fetch: (async () => forbidWholeBody(new Response(null, { status: 403 }))) as typeof fetch,
          write: () => undefined,
          id: () => 'unused',
        },
      ),
      /Upload failed with HTTP 403/,
    );

    const destination = join(directory, 'failed.png');
    await assert.rejects(
      handleTransferCommand(
        'download',
        parseArgs(['as_ready', '--space', 'acme/salt', '--out', destination]),
        {
          client: async () => ({
            call: async () => ({
              asset: {
                asset_id: 'as_ready',
                status: 'ready',
                media_url: 'https://media.example/signed',
                media: { mime: 'image/png', size_bytes: 4 },
              },
            }),
          }),
          fetch: (async () => forbidWholeBody(new Response(null, { status: 502 }))) as typeof fetch,
          write: () => undefined,
          id: () => 'temporary',
        },
      ),
      /Download failed with HTTP 502/,
    );
    assert.deepEqual(await readdir(directory), ['fixture.png']);

    let fetched = false;
    await assert.rejects(
      handleTransferCommand('download', parseArgs(['as_waiting', '--space', 'acme/salt']), {
        client: async () => ({
          call: async () => ({ asset: { asset_id: 'as_waiting', status: 'generating', media_url: null } }),
        }),
        fetch: (async () => ((fetched = true), new Response())) as typeof fetch,
        write: () => undefined,
        id: () => 'unused',
      }),
      /not ready for download/,
    );
    assert.equal(fetched, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
