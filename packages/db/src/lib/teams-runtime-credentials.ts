import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

export type TeamsBotRuntimeCredentials = {
  botAppId: string | null;
  botAppPassword: string | null;
  botTenantId: string | null;
  botTokenEndpoint: string | null;
  botOauthScope: string | null;
  /**
   * Which app registration the id/password pair came from: dedicated
   * `TEAMS_BOT_*` values, or the Microsoft sign-in app
   * (`ROOMOTE_AUTH_MICROSOFT_*`) doubling as the bot app.
   */
  source: 'teams_bot' | 'microsoft_auth' | null;
};

const TEAMS_CREDENTIAL_ENV_VAR_NAMES = [
  'TEAMS_BOT_APP_ID',
  'TEAMS_BOT_APP_PASSWORD',
  'TEAMS_BOT_TENANT_ID',
  'TEAMS_BOT_NAME',
  'TEAMS_BOT_TOKEN_ENDPOINT',
  'TEAMS_BOT_OAUTH_SCOPE',
  'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
  'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
  'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
] as const;

const CACHE_TTL_MS = 30_000;

let cachedCredentials: {
  value: TeamsBotRuntimeCredentials;
  expiresAtMs: number;
} | null = null;

function trimmed(value: string | undefined): string | null {
  return value?.trim() || null;
}

function buildCredentials(
  env: Partial<Record<string, string | undefined>>,
): TeamsBotRuntimeCredentials {
  const botTokenEndpoint = trimmed(env.TEAMS_BOT_TOKEN_ENDPOINT);
  const botOauthScope = trimmed(env.TEAMS_BOT_OAUTH_SCOPE);

  const teamsBotAppId = trimmed(env.TEAMS_BOT_APP_ID);
  const teamsBotAppPassword = trimmed(env.TEAMS_BOT_APP_PASSWORD);

  // Never mix an id from one app registration with a secret from another:
  // the id/password pair (and its tenant) always comes from a single source.
  if (teamsBotAppId && teamsBotAppPassword) {
    return {
      botAppId: teamsBotAppId,
      botAppPassword: teamsBotAppPassword,
      botTenantId: trimmed(env.TEAMS_BOT_TENANT_ID),
      botTokenEndpoint,
      botOauthScope,
      source: 'teams_bot',
    };
  }

  const microsoftClientId = trimmed(env.ROOMOTE_AUTH_MICROSOFT_CLIENT_ID);
  const microsoftClientSecret = trimmed(
    env.ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET,
  );

  if (microsoftClientId && microsoftClientSecret) {
    return {
      botAppId: microsoftClientId,
      botAppPassword: microsoftClientSecret,
      botTenantId: trimmed(env.ROOMOTE_AUTH_MICROSOFT_TENANT_ID),
      botTokenEndpoint,
      botOauthScope,
      source: 'microsoft_auth',
    };
  }

  return {
    botAppId: null,
    botAppPassword: null,
    botTenantId: null,
    botTokenEndpoint,
    botOauthScope,
    source: null,
  };
}

/**
 * Resolve the Teams bot credentials the way operators configure them: real
 * environment variables always win per variable, values saved from the
 * settings UI (encrypted deployment env vars) fill gaps, and when no
 * dedicated `TEAMS_BOT_*` pair is configured the Microsoft sign-in app
 * doubles as the bot app — a single Entra app registration can serve both
 * roles. Resolved values are cached briefly so webhook-path callers do not
 * hit the database on every activity.
 */
export async function resolveTeamsBotRuntimeCredentials(): Promise<TeamsBotRuntimeCredentials> {
  const fromEnv = buildCredentials(process.env);

  if (fromEnv.source === 'teams_bot') {
    return fromEnv;
  }

  const nowMs = Date.now();

  if (cachedCredentials && cachedCredentials.expiresAtMs > nowMs) {
    return cachedCredentials.value;
  }

  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const merged: Partial<Record<string, string | undefined>> = {};

  for (const name of TEAMS_CREDENTIAL_ENV_VAR_NAMES) {
    merged[name] = process.env[name]?.trim() || deploymentEnvVars[name];
  }

  const value = buildCredentials(merged);

  cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };

  return value;
}

/** Drop the cached credentials, e.g. right after the settings UI saves. */
export function invalidateTeamsBotRuntimeCredentialsCache(): void {
  cachedCredentials = null;
}
