import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { handleDataCommand } from './read.ts';
import { parseArgs } from '../lib/utils.ts';

// Public list_models price fields; see CONTRIBUTING.md for refreshing this snapshot.
const models = JSON.parse(
  readFileSync(new URL('../../test/fixtures/catalog-prices.json', import.meta.url), 'utf8'),
);

test('models JSON preserves the service own-key fees and recorded terms', async () => {
  const output: string[] = [];
  await handleDataCommand('models', parseArgs(['--json']), {
    client: async () => ({ call: async () => ({ models }) }),
    write: (text) => output.push(text),
  });
  assert.deepEqual(JSON.parse(output[0] ?? ''), { models });
  assert.deepEqual(
    models.find((model: { id: string }) => model.id === 'audio/lyria-3.5').price.own_key,
    { unit: 'second', credits: 2, seconds: 60, estimated_seconds: 180 },
  );
});

test('estimate displays the account-aware service quote without applying managed-price arithmetic', async () => {
  const output: string[] = [];
  await handleDataCommand(
    'estimate',
    parseArgs(['--kind', 'video', '--model', 'video/h3-max', '--param', 'duration_seconds=8']),
    {
      client: async () => ({
        call: async (name) => {
          assert.equal(name, 'estimate_credits');
          return { credits: 5, balance_after_credits: 995, billing: 'own_key' };
        },
      }),
      write: (text) => output.push(text),
    },
  );
  assert.deepEqual(output, ['5 credits (995 after)']);
});
