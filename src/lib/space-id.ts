const LOCAL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCAL_ID_MAX_LENGTH = 63;

export type CanonicalSpaceId = { accountId: string; spaceId: string };

function isLocalId(value: string): boolean {
  return value.length <= LOCAL_ID_MAX_LENGTH && LOCAL_ID_PATTERN.test(value);
}

/** Split `account/space`, or return null when either half is not a valid id. */
export function parseCanonicalSpaceId(value: string): CanonicalSpaceId | null {
  const slash = value.indexOf('/');
  if (slash < 1 || slash !== value.lastIndexOf('/')) return null;
  const accountId = value.slice(0, slash);
  const spaceId = value.slice(slash + 1);
  return isLocalId(accountId) && isLocalId(spaceId) ? { accountId, spaceId } : null;
}
