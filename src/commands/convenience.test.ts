import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseArgs } from '../lib/utils.ts';
import { handleExport, handleOpen } from './convenience.ts';

const dependencies = (overrides: Record<string, unknown> = {}) => ({
  client: async () => ({ call: async () => ({}) }),
  write: () => undefined,
  openUrl: async () => undefined,
  id: () => 'temporary',
  env: {},
  ...overrides,
});

test('exports with one tool call and atomically publishes a new destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-export-'));
  try {
    const destination = join(directory, 'space.json');
    const result = { export_version: 1, space: { id: 'acme/salt' }, assets: [], links: [] };
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const output: string[] = [];
    await handleExport(
      parseArgs(['--space', 'acme/salt', '--starred-only', '--out', destination]),
      dependencies({
        client: async () => ({
          call: async (name: string, args: Record<string, unknown>) => (calls.push({ name, args }), result),
        }),
        write: (text: string) => output.push(text),
      }),
    );

    assert.deepEqual(calls, [{ name: 'export_space', args: { space_id: 'acme/salt', starred_only: true } }]);
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), result);
    assert.deepEqual(await readdir(directory), ['space.json']);
    assert.deepEqual(output, [resolve(destination)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('export refuses an existing destination before authentication and prints JSON without --out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-export-existing-'));
  try {
    const destination = join(directory, 'keep.json');
    await writeFile(destination, 'keep');
    let clients = 0;
    await assert.rejects(
      handleExport(
        parseArgs(['--space', 'acme/salt', '--out', destination]),
        dependencies({
          client: async () => {
            clients += 1;
            return { call: async () => ({}) };
          },
        }),
      ),
      /Destination already exists/,
    );
    assert.equal(clients, 0);
    assert.equal(await readFile(destination, 'utf8'), 'keep');

    const output: string[] = [];
    await handleExport(
      parseArgs(['--space', 'acme/salt']),
      dependencies({
        client: async () => ({ call: async () => ({ export_version: 1 }) }),
        write: (text: string) => output.push(text),
      }),
    );
    assert.deepEqual(JSON.parse(output[0] ?? ''), { export_version: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('export does not replace a destination created while the tool call is in flight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makefx-export-race-'));
  try {
    const destination = join(directory, 'winner.json');
    await assert.rejects(
      handleExport(
        parseArgs(['--space', 'acme/salt', '--out', destination]),
        dependencies({
          client: async () => ({
            call: async () => {
              await writeFile(destination, 'winner');
              return { export_version: 1 };
            },
          }),
        }),
      ),
      /Destination already exists/,
    );
    assert.equal(await readFile(destination, 'utf8'), 'winner');
    assert.deepEqual(await readdir(directory), ['winner.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('export validates required arguments before authentication', async () => {
  let clients = 0;
  await assert.rejects(
    handleExport(
      parseArgs([]),
      dependencies({
        client: async () => {
          clients += 1;
          return { call: async () => ({}) };
        },
      }),
    ),
    /export requires --space/,
  );
  assert.equal(clients, 0);
});

test('open prints canonical URLs and makes one matching public tool call', async () => {
  const cases = [
    {
      argv: ['acme/salt', '--no-open'],
      name: 'get_space',
      args: { space_id: 'acme/salt', starred_only: false },
      url: 'https://makefx.app/s/acme/salt',
    },
    {
      argv: ['as_one', '--space', 'acme/salt'],
      name: 'get_asset',
      args: { space_id: 'acme/salt', asset_id: 'as_one', wait_seconds: 0 },
      url: 'https://makefx.app/s/acme/salt/a/as_one',
    },
  ];

  for (const item of cases) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const output: string[] = [];
    const opened: string[] = [];
    await handleOpen(
      parseArgs(item.argv),
      dependencies({
        client: async () => ({
          call: async (name: string, args: Record<string, unknown>) => (
            calls.push({ name, args }),
            { web_url: item.url }
          ),
        }),
        write: (text: string) => output.push(text),
        openUrl: async (url: string) => void opened.push(url),
      }),
    );
    assert.deepEqual(calls, [{ name: item.name, args: item.args }]);
    assert.deepEqual(output, [item.url]);
    assert.deepEqual(opened, item.argv.includes('--no-open') ? [] : [item.url]);
  }
});

test('MAKEFX_NO_OPEN disables opening without changing stdout', async () => {
  const output: string[] = [];
  let opened = false;
  await handleOpen(
    parseArgs(['acme/salt']),
    dependencies({
      client: async () => ({ call: async () => ({ web_url: 'https://makefx.app/s/acme/salt' }) }),
      write: (text: string) => output.push(text),
      openUrl: async () => void (opened = true),
      env: { MAKEFX_NO_OPEN: '1' },
    }),
  );
  assert.deepEqual(output, ['https://makefx.app/s/acme/salt']);
  assert.equal(opened, false);
});

test('open validates the target shape before authentication', async () => {
  let clients = 0;
  const deps = dependencies({
    client: async () => {
      clients += 1;
      return { call: async () => ({}) };
    },
  });
  await assert.rejects(handleOpen(parseArgs(['as_one']), deps), /asset target requires --space/);
  await assert.rejects(
    handleOpen(parseArgs(['acme/salt', '--space', 'acme/other']), deps),
    /space target does not accept --space/i,
  );
  assert.equal(clients, 0);
});
