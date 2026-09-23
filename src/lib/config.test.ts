import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getConfigPath, withConfigLock } from './config.ts';

describe('withConfigLock', () => {
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'cli-lock-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(configHome, { recursive: true, force: true });
  });

  test('holders run one at a time and the lock is gone afterwards', async () => {
    const order: string[] = [];
    await Promise.all([
      withConfigLock(async () => {
        order.push('a:start');
        await new Promise((resolve) => setTimeout(resolve, 60));
        order.push('a:end');
      }),
      withConfigLock(async () => {
        order.push('b:start');
        await new Promise((resolve) => setTimeout(resolve, 60));
        order.push('b:end');
      }),
    ]);
    const holders = order[0] === 'a:start' ? ['a', 'b'] : ['b', 'a'];
    assert.deepEqual(
      order,
      holders.flatMap((holder) => [`${holder}:start`, `${holder}:end`]),
    );
    assert.equal(existsSync(`${await getConfigPath()}.lock`), false);
  });

  test('a stale lock is taken over, and a lock owned by someone else is never removed', async () => {
    const lockPath = `${await getConfigPath()}.lock`;
    rmSync(lockPath, { force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(lockPath, '..'), { recursive: true });
    writeFileSync(lockPath, 'dead-process');
    const longAgo = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(lockPath, longAgo, longAgo);

    await withConfigLock(async () => {
      // Simulate another process taking the lock over mid-flight.
      writeFileSync(lockPath, 'someone-else');
    });
    assert.equal(readFileSync(lockPath, 'utf8'), 'someone-else');
  });
});
