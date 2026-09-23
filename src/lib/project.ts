/** The service this client talks to, and where each environment answers. */
export const SERVICE_NAME = 'makefx.app';
export const CONFIG_DIR_NAME = 'makefx-cli';

export const ENVIRONMENT_ORIGINS = {
  production: 'https://makefx.app',
  stage: 'https://stage.makefx.app',
  local: 'https://localhost:3002',
} as const;
