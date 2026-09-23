import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

async function saveMultiEnvConfig(multiConfig: MultiEnvConfig): Promise<void> {
  const configPath = await getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(multiConfig, null, 2), 'utf8');
}

export async function saveConfig(config: StoredConfig): Promise<void> {
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
  await mkdir(path.dirname(lockPath), { recursive: true });
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
      if (age > LOCK_STALE_MS) {
        // Two contenders can both find the same lock stale. A rename is atomic,
        // so exactly one of them retires it; the other's rename fails and it
        // simply tries the lock again, now against the winner's fresh file.
        const retired = `${lockPath}.stale-${process.pid}`;
        await rename(lockPath, retired).catch(() => undefined);
        await rm(retired, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Another process holds ${lockPath}; remove it if no other CLI is running`);
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
