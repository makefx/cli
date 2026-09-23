import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from './utils.ts';

test('keeps every repeated option while retaining the last scalar value', () => {
  const parsed = parseArgs([
    '--ref',
    'as_one:first',
    '--ref=as_two:last',
    '--param',
    't=3.25',
    '--param=fit=true',
  ]);

  assert.deepEqual(parsed.values.ref, ['as_one:first', 'as_two:last']);
  assert.deepEqual(parsed.values.param, ['t=3.25', 'fit=true']);
  assert.equal(parsed.options.ref, 'as_two:last');
  assert.equal(parsed.options.param, 'fit=true');
});
