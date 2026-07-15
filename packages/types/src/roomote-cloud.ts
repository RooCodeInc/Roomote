/**
 * Roomote Cloud ships dark: only deployment tooling may opt a tenant in.
 * Accept the raw process-env forms and the boolean produced by @roomote/env.
 */
export function isRoomoteCloudEnabled(
  runtimeEnv: Partial<Record<string, unknown>>,
): boolean {
  const value = runtimeEnv.ROOMOTE_CLOUD_ENABLED;

  return value === true || value === 'true' || value === '1';
}
