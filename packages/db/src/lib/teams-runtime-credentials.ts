import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';
import {
  resolveTeamsBotRuntimeCredentialsFromEnv,
  TEAMS_BOT_CREDENTIAL_ENV_VAR_NAMES,
  type TeamsBotRuntimeCredentials,
} from '@roomote/types';

export type { TeamsBotRuntimeCredentials } from '@roomote/types';

const CACHE_TTL_MS = 30_000;

let cachedCredentials: {
  value: TeamsBotRuntimeCredentials;
  expiresAtMs: number;
} | null = null;

/**
 * Resolve the Teams bot credentials the way operators configure them: real
 * environment variables always win per variable, values saved from the
 * settings UI (encrypted deployment env vars) fill gaps. Resolved values are
 * cached briefly so webhook-path callers do not hit the database on every
 * activity.
 */
export async function resolveTeamsBotRuntimeCredentials(): Promise<TeamsBotRuntimeCredentials> {
  const fromEnv = resolveTeamsBotRuntimeCredentialsFromEnv(process.env);

  if (fromEnv.source === 'teams_bot') {
    return fromEnv;
  }

  const nowMs = Date.now();

  if (cachedCredentials && cachedCredentials.expiresAtMs > nowMs) {
    return cachedCredentials.value;
  }

  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const merged: Partial<Record<string, string | undefined>> = {};

  for (const name of TEAMS_BOT_CREDENTIAL_ENV_VAR_NAMES) {
    merged[name] = process.env[name]?.trim() || deploymentEnvVars[name];
  }

  const value = resolveTeamsBotRuntimeCredentialsFromEnv(merged);

  cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };

  return value;
}

/** Drop the cached credentials, e.g. right after the settings UI saves. */
export function invalidateTeamsBotRuntimeCredentialsCache(): void {
  cachedCredentials = null;
}
