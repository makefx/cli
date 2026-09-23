import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertJsonSchema, validateJsonSchema } from './json-schema.ts';

// A snapshot of the parameter schemas the service's model catalog emits; see
// CONTRIBUTING.md for how it is refreshed.
const catalog = JSON.parse(
  readFileSync(new URL('../../test/fixtures/catalog-params.json', import.meta.url), 'utf8'),
) as { id: string; schema: unknown }[];

test('accepts every parameter schema in the model catalog snapshot', () => {
  for (const entry of catalog) assertJsonSchema(entry.schema, entry.id);
});

test('validates the arrays, objects, bounds, required fields, and defaults emitted by the catalog', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { enum: ['short', 'long'], default: 'short' },
      fixed: { const: true },
      strength: { type: 'number', minimum: 0, maximum: 1 },
      title: { type: 'string', minLength: 2, maxLength: 5 },
      clips: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          type: 'object',
          properties: { asset: { type: 'string' }, at: { type: 'integer', minimum: 0 } },
          required: ['asset', 'at'],
          additionalProperties: false,
        },
      },
      size: {
        anyOf: [
          {
            type: 'array',
            prefixItems: [{ const: 1920 }, { const: 1080 }],
            items: false,
            minItems: 2,
            maxItems: 2,
          },
          { const: 'match' },
        ],
      },
    },
    required: ['fixed', 'strength', 'title', 'clips', 'size'],
    additionalProperties: false,
  };
  assertJsonSchema(schema);
  assert.deepEqual(
    validateJsonSchema(schema, {
      fixed: true,
      strength: 0.5,
      title: 'Shot',
      clips: [{ asset: 'as_one', at: 0 }],
      size: [1920, 1080],
    }),
    {
      ok: true,
      value: {
        mode: 'short',
        fixed: true,
        strength: 0.5,
        title: 'Shot',
        clips: [{ asset: 'as_one', at: 0 }],
        size: [1920, 1080],
      },
    },
  );

  for (const value of [
    { fixed: false, strength: 0.5, title: 'Shot', clips: [{ asset: 'as_one', at: 0 }], size: 'match' },
    { fixed: true, strength: 2, title: 'Shot', clips: [{ asset: 'as_one', at: 0 }], size: 'match' },
    { fixed: true, strength: 0.5, title: 'S', clips: [{ asset: 'as_one', at: 0 }], size: 'match' },
    { fixed: true, strength: 0.5, title: 'Shot', clips: [], size: 'match' },
    {
      fixed: true,
      strength: 0.5,
      title: 'Shot',
      clips: [{ asset: 'as_one', at: 0, extra: true }],
      size: 'match',
    },
    { fixed: true, strength: 0.5, title: 'Shot', clips: [{ asset: 'as_one' }], size: 'match' },
    { fixed: true, strength: 0.5, title: 'Shot', clips: [{ asset: 'as_one', at: 0 }], size: [1080, 1920] },
  ]) {
    assert.equal(validateJsonSchema(schema, value).ok, false);
  }
});

test('rejects malformed or unsupported schema instead of ignoring it', () => {
  assert.throws(() => assertJsonSchema({ type: 'object', pattern: '^x' }), /unsupported keyword/);
  assert.throws(() => assertJsonSchema({ type: 'array', items: 'string' }), /items must be an object/);
  assert.throws(() => assertJsonSchema({ minItems: 2, maxItems: 1 }), /must not exceed/);
});
