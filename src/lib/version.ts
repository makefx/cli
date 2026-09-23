declare const __MAKEFX_CLI_VERSION__: string | undefined;

/** The package version, injected at build time; source runs report a dev build. */
export const CLI_VERSION =
  typeof __MAKEFX_CLI_VERSION__ === 'string' ? __MAKEFX_CLI_VERSION__ : '0.0.0-dev';
