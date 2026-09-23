import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliUsageError } from './errors.ts';
import { CONFIG_DIR_NAME as SERVICE_CONFIG_DIR, ENVIRONMENT_ORIGINS } from './project.ts';
import type { StoredConfig, MultiEnvConfig } from './types.ts';

export const DEFAULT_ENVIRONMENT = 'production';
const CONFIG_DIR_NAME = SERVICE_CONFIG_DIR;
const CONFIG_FILE_NAME = 'config.json';

async function loadMultiEnvConfig(): Promise<MultiEnvConfig | null> {
  const configPath = await getConfigPath();
  try {
    const raw = await readFile(configPath, 'utf8');
    const data = JSON.parse(raw);

    // Handle legacy single config format
    if (data.environment && data.token && !data.configs) {
      const legacyConfig = data as StoredConfig;
      return {
        configs: {
          [legacyConfig.environment]: legacyConfig,
        },
      };
    }

    return data as MultiEnvConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * The file holds refresh tokens, so only its owner may read it. It is written
 * beside the old one and renamed over it, so a reader never sees half a file
 * and a file first saved by an older client loses its wider permissions.
 */
async function saveMultiEnvConfig(multiConfig: MultiEnvConfig): Promise<void> {
  const configPath = await getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(multiConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, configPath);
}

/**
 * Every write reads the whole file and replaces it, so each one runs under
 * the config lock: otherwise a login or logout could write back a refresh
 * token that a concurrent refresh has just consumed.
 */
export async function saveConfig(config: StoredConfig): Promise<void> {
  await withConfigLock(() => saveConfigHoldingLock(config));
}

/** saveConfig for a caller already inside withConfigLock, which is not reentrant. */
export async function saveConfigHoldingLock(config: StoredConfig): Promise<void> {
  const multiConfig = (await loadMultiEnvConfig()) || { configs: {} };
  multiConfig.configs[config.environment] = config;
  await saveMultiEnvConfig(multiConfig);
}

export async function loadStoredConfig(environment?: string): Promise<StoredConfig | null> {
  const multiConfig = await loadMultiEnvConfig();
  if (!multiConfig) return null;

  // Always use the provided environment, never fall back to a stored default
  const env = environment || DEFAULT_ENVIRONMENT;
  return multiConfig.configs[env] || null;
}

/** Every environment with stored credentials. */
export async function listStoredConfigs(): Promise<StoredConfig[]> {
  const multiConfig = await loadMultiEnvConfig();
  return multiConfig ? Object.values(multiConfig.configs) : [];
}

export async function removeConfig(environment?: string): Promise<void> {
  await withConfigLock(() => removeConfigHoldingLock(environment));
}

async function removeConfigHoldingLock(environment?: string): Promise<void> {
  if (!environment) {
    // Remove all configs
    const configPath = await getConfigPath();
    await rm(configPath);
    return;
  }

  // Remove specific environment config
  const multiConfig = await loadMultiEnvConfig();
  if (multiConfig) {
    delete multiConfig.configs[environment];

    if (Object.keys(multiConfig.configs).length === 0) {
      // If no configs left, remove the file
      const configPath = await getConfigPath();
      await rm(configPath);
    } else {
      await saveMultiEnvConfig(multiConfig);
    }
  }
}

/**
 * How long a lock may sit before it is taken for a crashed process's
 * leftover. Everything that runs under the lock is bounded well below this
 * (see REFRESH_TIMEOUT_MS in tokens.ts), so a live holder is never mistaken
 * for a dead one.
 */
const LOCK_STALE_MS = 60_000;
/** How long to wait for another process before giving up. */
const LOCK_WAIT_MS = 10_000;

type StaleLockRecovery = 'retired' | 'fresh' | 'takeover-held';

/**
 * Removes a lock left by a crashed process.
 *
 * Two contenders can both find the same lock stale, and the first to retire
 * it may already hold a fresh one by the time the second acts. Recovery is
 * therefore serialized through a takeover file, and the lock is re-checked
 * under it: a lock that is no longer stale is left alone. The takeover file
 * lives for two file operations and is never removed by anyone but its
 * creator, so one left by a crash in that window waits for a person.
 */
async function retireStaleLock(lockPath: string): Promise<StaleLockRecovery> {
  let takeover;
  try {
    takeover = await open(takeoverPathFor(lockPath), 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'takeover-held';
    throw error;
  }
  try {
    await takeover.close();
    const age = Date.now() - ((await stat(lockPath).catch(() => null))?.mtimeMs ?? Date.now());
    if (age <= LOCK_STALE_MS) return 'fresh';
    await rm(lockPath, { force: true });
    return 'retired';
  } finally {
    await rm(takeoverPathFor(lockPath), { force: true });
  }
}

function takeoverPathFor(lockPath: string): string {
  return `${lockPath}.takeover`;
}

/**
 * Runs `fn` while holding an exclusive lock on the config file.
 *
 * A refresh token is single-use, so two processes that both hold the same one
 * must not both present it: the second would look like a replay and cost the
 * grant. Whatever reads the stored token and may replace it runs under this
 * lock and re-reads the file first, so the second process finds the first
 * one's result instead of racing it.
 */
export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${await getConfigPath()}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  // The lock names its owner, so a process only ever removes its own lock and
  // never one another process took over after a takeover of a stale file.
  const owner = `${process.pid}:${Math.random().toString(36).slice(2)}`;

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(owner, 'utf8');
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const age = Date.now() - ((await stat(lockPath).catch(() => null))?.mtimeMs ?? Date.now());
      const recovery = age > LOCK_STALE_MS ? await retireStaleLock(lockPath) : 'fresh';
      if (recovery === 'retired') continue;
      if (Date.now() > deadline) {
        throw new Error(
          recovery === 'takeover-held'
            ? `A crashed process left ${takeoverPathFor(lockPath)}; remove it and ${lockPath} if no other CLI is running`
            : `Another process holds ${lockPath}; remove it if no other CLI is running`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }

  try {
    return await fn();
  } finally {
    const holder = await readFile(lockPath, 'utf8').catch(() => null);
    if (holder === owner) {
      await rm(lockPath, { force: true });
    }
  }
}

export async function getConfigPath(): Promise<string> {
  const baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(baseDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function resolveBaseUrl(env: string): string {
  switch (env) {
    case 'production':
      return ENVIRONMENT_ORIGINS.production;
    case 'stage':
    case 'staging':
      return ENVIRONMENT_ORIGINS.stage;
    case 'local':
      return ENVIRONMENT_ORIGINS.local;
    default:
      throw new CliUsageError(`Unknown environment "${env}". Valid options: production, stage, local`);
  }
}
