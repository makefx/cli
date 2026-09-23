import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getConfigPath, loadStoredConfig, saveConfig, withConfigLock } from './config.ts';
import type { StoredConfig } from './types.ts';

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

  test('contenders that all find the same stale lock still hold it one at a time', async () => {
    const lockPath = `${await getConfigPath()}.lock`;
    mkdirSync(join(lockPath, '..'), { recursive: true });
    writeFileSync(lockPath, 'dead-process');
    const longAgo = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(lockPath, longAgo, longAgo);

    let holders = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withConfigLock(async () => {
          most = Math.max(most, ++holders);
          await new Promise((resolve) => setTimeout(resolve, 20));
          holders--;
        }),
      ),
    );
    assert.equal(most, 1);
    assert.equal(existsSync(`${lockPath}.takeover`), false);
  });
});

describe('saveConfig', () => {
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'cli-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(configHome, { recursive: true, force: true });
  });

  const stored: StoredConfig = {
    environment: 'production',
    baseUrl: 'https://makefx.app',
    clientId: 'cli',
    token: { accessToken: 'access', refreshToken: 'refresh', issuedAt: 1, expiresAt: 2 },
    user: null,
    updatedAt: '2026-09-23T12:00:00.000Z',
  };

  test('stored credentials are readable only by their owner', { skip: process.platform === 'win32' }, async () => {
    const configPath = await getConfigPath();
    // A file saved by an older client that did not restrict it.
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ configs: {} }), { mode: 0o644 });

    await saveConfig(stored);

    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(await loadStoredConfig('production'), stored);
  });

  test('a new credentials directory is private to its owner', { skip: process.platform === 'win32' }, async () => {
    await saveConfig(stored);
    assert.equal(statSync(join(await getConfigPath(), '..')).mode & 0o777, 0o700);
  });

  test('concurrent saves for different environments keep both', async () => {
    await Promise.all(
      ['production', 'stage', 'local'].map((environment) => saveConfig({ ...stored, environment })),
    );
    for (const environment of ['production', 'stage', 'local']) {
      assert.equal((await loadStoredConfig(environment))?.environment, environment);
    }
  });
});
