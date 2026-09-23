import type { ParsedArgs } from '../lib/types.ts';
import { listStoredConfigs, loadStoredConfig, removeConfig } from '../lib/config.ts';
import { revokeStoredToken } from '../lib/tokens.ts';

/**
 * Ends the grant on the server before forgetting it locally, so the app
 * disappears from the person's connected apps and any token minted under
 * the grant stops working. Revocation is best effort: being offline is not
 * a reason to keep credentials on disk.
 */
export async function handleLogout(parsed: ParsedArgs) {
  const isLocal = parsed.options.local === 'true';
  const environment = isLocal ? 'local' : parsed.options.env || undefined;

  const configs = environment
    ? [await loadStoredConfig(environment)].filter((config) => config !== null)
    : await listStoredConfigs();

  for (const config of configs) {
    const revoked = await revokeStoredToken(config);
    console.log(
      revoked
        ? `Revoked access for environment "${config.environment}".`
        : `Could not reach ${config.baseUrl} to revoke access for "${config.environment}"; the grant expires on its own.`,
    );
  }

  try {
    if (environment) {
      await removeConfig(environment);
      console.log(`Removed stored credentials for environment "${environment}".`);
    } else {
      await removeConfig();
      console.log('Removed all stored credentials.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No stored credentials were found.');
      return;
    }
    throw error;
  }
}
