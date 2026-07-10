import {
  createTeamsCommunicationProviderFromEnv,
  type TeamsBotEnvConfig,
  type TeamsCommunicationProvider,
} from '@roomote/communication/teams-provider';
import {
  resolveTeamsBotRuntimeCredentials,
  type TeamsBotRuntimeCredentials,
} from '@roomote/db/server';

function teamsBotEnvConfigFromCredentials(
  credentials: TeamsBotRuntimeCredentials,
): TeamsBotEnvConfig {
  return {
    ...(credentials.botAppId
      ? { R_TEAMS_BOT_APP_ID: credentials.botAppId }
      : {}),
    ...(credentials.botAppPassword
      ? { R_TEAMS_BOT_APP_PASSWORD: credentials.botAppPassword }
      : {}),
    ...(credentials.botTenantId
      ? { R_TEAMS_BOT_TENANT_ID: credentials.botTenantId }
      : {}),
    ...(credentials.botTokenEndpoint
      ? { R_TEAMS_BOT_TOKEN_ENDPOINT: credentials.botTokenEndpoint }
      : {}),
    ...(credentials.botOauthScope
      ? { R_TEAMS_BOT_OAUTH_SCOPE: credentials.botOauthScope }
      : {}),
  };
}

/**
 * Builds a `TeamsCommunicationProvider` from the resolved runtime
 * credentials (env vars, settings-UI values, or the Microsoft sign-in app
 * doubling as the bot app), or `null` when no bot is configured.
 */
export async function createTeamsCommunicationProviderFromRuntimeCredentials(): Promise<TeamsCommunicationProvider | null> {
  const credentials = await resolveTeamsBotRuntimeCredentials();

  return createTeamsCommunicationProviderFromEnv(
    teamsBotEnvConfigFromCredentials(credentials),
  );
}
