import assert from 'node:assert/strict';
import test from 'node:test';
import { BillingIdentityError, parseBillingIdentity } from './billing.ts';

const identity = {
  name: 'Ada Example',
  email: 'ada@example.com',
  address: { line1: '1 Market Street', city: 'Lisbon', postal_code: '1100-148', country: 'PT' },
};

function refusal(value: unknown): { path: string; message: string } {
  try {
    parseBillingIdentity(value);
  } catch (error) {
    assert.ok(error instanceof BillingIdentityError);
    return { path: error.path, message: error.message };
  }
  assert.fail('expected the billing identity to be refused');
}

test('accepts a complete identity and keeps only its known fields', () => {
  const full = {
    ...identity,
    address: { ...identity.address, line2: 'Floor 2', state: 'Lisboa' },
    tax_id: { type: 'eu_vat', value: 'PT123456789' },
  };
  assert.deepEqual(parseBillingIdentity(full), full);
  assert.deepEqual(parseBillingIdentity(identity), identity);
});

test('email addresses follow the service rule', () => {
  for (const email of ["o'neil+bills@mail.example.co", 'a_b-c@sub-domain.example.org']) {
    assert.equal(parseBillingIdentity({ ...identity, email }).email, email);
  }
  for (const email of ['@', 'ada', '.ada@example.com', 'ada..test@example.com', 'ada.@example.com', 'ada@example.c', 'ada@-example.com', 'ada@example']) {
    assert.deepEqual(refusal({ ...identity, email }), { path: 'email', message: 'must be an email address.' });
  }
});

test('names the field that is missing, too long, malformed, or unknown', () => {
  assert.equal(refusal({ ...identity, name: '' }).path, 'name');
  assert.equal(refusal({ ...identity, name: 'x'.repeat(201) }).path, 'name');
  assert.equal(refusal({ ...identity, address: { ...identity.address, country: 'pt' } }).path, 'address.country');
  assert.equal(refusal({ ...identity, address: { ...identity.address, city: undefined } }).path, 'address.city');
  assert.equal(refusal({ ...identity, card_number: '4242' }).path, 'card_number');
  assert.equal(refusal({ ...identity, address: { ...identity.address, cvc: '123' } }).path, 'address.cvc');
  assert.equal(refusal({ ...identity, tax_id: { type: 'us_ein', value: '1' } }).path, 'tax_id.type');
  assert.equal(refusal([identity]).path, '');
});
