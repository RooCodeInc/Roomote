export type TeamsBotCredentialSource = 'teams_bot' | 'microsoft_auth' | null;

export type TeamsBotRuntimeCredentials = {
  botAppId: string | null;
  botAppPassword: string | null;
  botTenantId: string | null;
  botTokenEndpoint: string | null;
  botOauthScope: string | null;
  source: TeamsBotCredentialSource;
};

export const TEAMS_BOT_CREDENTIAL_ENV_VAR_NAMES = [
  'R_TEAMS_BOT_APP_ID',
  'R_TEAMS_BOT_APP_PASSWORD',
  'R_TEAMS_BOT_TENANT_ID',
  'R_TEAMS_BOT_NAME',
  'R_TEAMS_BOT_TOKEN_ENDPOINT',
  'R_TEAMS_BOT_OAUTH_SCOPE',
] as const;

export const MICROSOFT_SINGLE_APP_TEAMS_BOT_FIELD_SOURCES = {
  R_TEAMS_BOT_APP_ID: 'R_MICROSOFT_CLIENT_ID',
  R_TEAMS_BOT_APP_PASSWORD: 'R_MICROSOFT_CLIENT_SECRET',
  R_TEAMS_BOT_TENANT_ID: 'R_MICROSOFT_TENANT_ID',
} as const;

export type TeamsBotInferredFieldEnvVarName =
  keyof typeof MICROSOFT_SINGLE_APP_TEAMS_BOT_FIELD_SOURCES;

export type TeamsBotCredentialEnvVarResolution = {
  source: TeamsBotCredentialSource;
  fieldSourceEnvVarNames: Partial<
    Record<TeamsBotInferredFieldEnvVarName, string>
  >;
};

function trimmed(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function resolveTeamsBotCredentialEnvVarNames(input: {
  hasConfiguredEnvVar: (name: string) => boolean;
}): TeamsBotCredentialEnvVarResolution {
  const hasTeamsBotAppId = input.hasConfiguredEnvVar('R_TEAMS_BOT_APP_ID');
  const hasTeamsBotAppPassword = input.hasConfiguredEnvVar(
    'R_TEAMS_BOT_APP_PASSWORD',
  );

  if (hasTeamsBotAppId && hasTeamsBotAppPassword) {
    return {
      source: 'teams_bot',
      fieldSourceEnvVarNames: {
        R_TEAMS_BOT_APP_ID: 'R_TEAMS_BOT_APP_ID',
        R_TEAMS_BOT_APP_PASSWORD: 'R_TEAMS_BOT_APP_PASSWORD',
        ...(input.hasConfiguredEnvVar('R_TEAMS_BOT_TENANT_ID')
          ? { R_TEAMS_BOT_TENANT_ID: 'R_TEAMS_BOT_TENANT_ID' }
          : {}),
      },
    };
  }

  const hasMicrosoftClientId = input.hasConfiguredEnvVar(
    'R_MICROSOFT_CLIENT_ID',
  );
  const hasMicrosoftClientSecret = input.hasConfiguredEnvVar(
    'R_MICROSOFT_CLIENT_SECRET',
  );

  if (hasMicrosoftClientId && hasMicrosoftClientSecret) {
    return {
      source: 'microsoft_auth',
      fieldSourceEnvVarNames: {
        R_TEAMS_BOT_APP_ID: 'R_MICROSOFT_CLIENT_ID',
        R_TEAMS_BOT_APP_PASSWORD: 'R_MICROSOFT_CLIENT_SECRET',
        ...(input.hasConfiguredEnvVar('R_MICROSOFT_TENANT_ID')
          ? { R_TEAMS_BOT_TENANT_ID: 'R_MICROSOFT_TENANT_ID' }
          : {}),
      },
    };
  }

  return {
    source: null,
    fieldSourceEnvVarNames: {},
  };
}

export function resolveTeamsBotRuntimeCredentialsFromEnv(
  env: Partial<Record<string, string | undefined>>,
): TeamsBotRuntimeCredentials {
  const botTokenEndpoint = trimmed(env.R_TEAMS_BOT_TOKEN_ENDPOINT);
  const botOauthScope = trimmed(env.R_TEAMS_BOT_OAUTH_SCOPE);
  const botAppId = trimmed(env.R_TEAMS_BOT_APP_ID);
  const botAppPassword = trimmed(env.R_TEAMS_BOT_APP_PASSWORD);

  if (botAppId && botAppPassword) {
    return {
      botAppId,
      botAppPassword,
      botTenantId: trimmed(env.R_TEAMS_BOT_TENANT_ID),
      botTokenEndpoint,
      botOauthScope,
      source: 'teams_bot',
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
