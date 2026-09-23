export type ParsedArgs = {
  options: Record<string, string>;
  values: Record<string, string[]>;
  positionals: string[];
};

export type StoredToken = {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  issuedAt: number;
  scope?: string;
  /**
   * Rotates on every refresh: the server consumes the presented token and
   * hands back the next one, so whatever is stored here is the only usable
   * copy. Absent for credentials saved before refresh support existed.
   */
  refreshToken?: string;
  /** Epoch milliseconds after which the refresh token stops working and a login is needed. */
  refreshExpiresAt?: number;
};

export type StoredConfig = {
  environment: string;
  baseUrl: string;
  clientId: string;
  token: StoredToken;
  user: unknown;
  updatedAt: string;
};

export type MultiEnvConfig = {
  configs: Record<string, StoredConfig>;
};
