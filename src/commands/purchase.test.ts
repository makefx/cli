import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolCallError } from '../lib/errors.ts';
import { parseArgs } from '../lib/utils.ts';
import { handlePurchaseCommand, purchaseToolCall } from './purchase.ts';

const billing = {
  name: 'Ada Example',
  email: 'ada@example.com',
  address: {
    line1: '1 Main Street',
    city: 'Berlin',
    postal_code: '10115',
    country: 'DE',
  },
  tax_id: { type: 'eu_vat', value: 'DE123456789' },
};

test('maps complete credit purchase input from inline JSON and a file', async () => {
  const expected = {
    name: 'create_credit_purchase',
    args: {
      account_id: 'acme',
      product: 'eur100',
      request_id: 'purchase-1',
      billing,
    },
  };
  assert.deepEqual(
    await purchaseToolCall(
      'purchase create',
      parseArgs([
        '--account',
        'acme',
        '--product',
        'eur100',
        '--request-id',
        'purchase-1',
        '--billing',
        JSON.stringify(billing),
      ]),
    ),
    expected,
  );
  assert.deepEqual(
    await purchaseToolCall(
      'purchase create',
      parseArgs([
        '--account',
        'acme',
        '--product',
        'eur100',
        '--request-id',
        'purchase-1',
        '--billing',
        '@billing.json',
      ]),
      async (path) => {
        assert.ok(path.endsWith('/billing.json'));
        return JSON.stringify(billing);
      },
    ),
    expected,
  );
  assert.deepEqual(await purchaseToolCall('purchase get', parseArgs(['--purchase', 'cp_one'])), {
    name: 'get_credit_purchase',
    args: { purchase_id: 'cp_one' },
  });
});

test('rejects malformed billing, payment fields, and unknown options before authentication', async () => {
  for (const args of [
    ['--billing', '{bad'],
    ['--billing', JSON.stringify({ ...billing, email: '@' })],
    ['--billing', '@bad-email.json'],
    ['--billing', JSON.stringify({ ...billing, card_number: '4242' })],
    ['--billing', JSON.stringify({ ...billing, address: { ...billing.address, country: 'de' } })],
    ['--card-token', 'tok_secret'],
  ]) {
    let authenticated = false;
    await assert.rejects(
      handlePurchaseCommand(
        'purchase create',
        parseArgs(['--account', 'acme', '--product', 'eur20', '--request-id', 'purchase-1', ...args]),
        {
          client: async () => {
            authenticated = true;
            throw new Error('must not authenticate');
          },
          read: async () => JSON.stringify({ ...billing, email: '@' }),
          write: () => undefined,
        },
      ),
      /billing|Unknown option/,
    );
    assert.equal(authenticated, false);
  }
});

test('prints concise human output and unchanged JSON, and preserves tool failures', async () => {
  const result = {
    purchase_id: 'cp_one',
    status: 'awaiting_payment',
    total_amount: 2380,
    currency: 'eur',
    payment_url: 'https://pay.example/cp_one',
  };
  const human: string[] = [];
  await handlePurchaseCommand(
    'purchase create',
    parseArgs(['--account', 'acme', '--product', 'eur20', '--request-id', 'purchase-1', '--env', 'stage']),
    {
      client: async (parsed) => {
        assert.equal(parsed.options.env, 'stage');
        return { call: async () => result };
      },
      read: async () => '',
      write: (text) => human.push(text),
    },
  );
  assert.deepEqual(human, ['cp_one · awaiting_payment · 23.80 EUR · https://pay.example/cp_one']);

  const json: string[] = [];
  await handlePurchaseCommand('purchase get', parseArgs(['--purchase', 'cp_one', '--json']), {
    client: async () => ({ call: async () => result }),
    read: async () => '',
    write: (text) => json.push(text),
  });
  assert.deepEqual(JSON.parse(json[0] ?? ''), result);

  const failure = new ToolCallError({ code: 'forbidden', message: 'Owner required.' }, 'failed');
  await assert.rejects(
    handlePurchaseCommand('purchase get', parseArgs(['--purchase', 'cp_one']), {
      client: async () => ({ call: async () => Promise.reject(failure) }),
      read: async () => '',
      write: () => undefined,
    }),
    (error) => error === failure,
  );
});
