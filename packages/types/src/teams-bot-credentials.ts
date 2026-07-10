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

export const MICROSOFT_SINGLE_APP_TEAMS_BOT_FIELD_SOURCES = {
  TEAMS_BOT_APP_ID: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
  TEAMS_BOT_APP_PASSWORD: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
  TEAMS_BOT_TENANT_ID: 'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
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

function hasConfiguredValue(
  env: Partial<Record<string, string | undefined>>,
  name: string,
): boolean {
  return trimmed(env[name]) !== null;
}

export function resolveTeamsBotCredentialEnvVarNames(input: {
  hasConfiguredEnvVar: (name: string) => boolean;
}): TeamsBotCredentialEnvVarResolution {
  const hasTeamsBotAppId = input.hasConfiguredEnvVar('TEAMS_BOT_APP_ID');
  const hasTeamsBotAppPassword = input.hasConfiguredEnvVar(
    'TEAMS_BOT_APP_PASSWORD',
  );

  if (hasTeamsBotAppId && hasTeamsBotAppPassword) {
    return {
      source: 'teams_bot',
      fieldSourceEnvVarNames: {
        TEAMS_BOT_APP_ID: 'TEAMS_BOT_APP_ID',
        TEAMS_BOT_APP_PASSWORD: 'TEAMS_BOT_APP_PASSWORD',
        ...(input.hasConfiguredEnvVar('TEAMS_BOT_TENANT_ID')
          ? { TEAMS_BOT_TENANT_ID: 'TEAMS_BOT_TENANT_ID' }
          : {}),
      },
    };
  }

  const hasMicrosoftClientId = input.hasConfiguredEnvVar(
    'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
  );
  const hasMicrosoftClientSecret = input.hasConfiguredEnvVar(
    'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
  );

  if (hasMicrosoftClientId && hasMicrosoftClientSecret) {
    return {
      source: 'microsoft_auth',
      fieldSourceEnvVarNames: {
        TEAMS_BOT_APP_ID: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
        TEAMS_BOT_APP_PASSWORD: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
        ...(input.hasConfiguredEnvVar('ROOMOTE_AUTH_MICROSOFT_TENANT_ID')
          ? { TEAMS_BOT_TENANT_ID: 'ROOMOTE_AUTH_MICROSOFT_TENANT_ID' }
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
  const botTokenEndpoint = trimmed(env.TEAMS_BOT_TOKEN_ENDPOINT);
  const botOauthScope = trimmed(env.TEAMS_BOT_OAUTH_SCOPE);
  const resolution = resolveTeamsBotCredentialEnvVarNames({
    hasConfiguredEnvVar: (name) => hasConfiguredValue(env, name),
  });

  if (resolution.source === 'teams_bot') {
    return {
      botAppId: trimmed(env.TEAMS_BOT_APP_ID),
      botAppPassword: trimmed(env.TEAMS_BOT_APP_PASSWORD),
      botTenantId: trimmed(env.TEAMS_BOT_TENANT_ID),
      botTokenEndpoint,
      botOauthScope,
      source: 'teams_bot',
    };
  }

  if (resolution.source === 'microsoft_auth') {
    return {
      botAppId: trimmed(env.ROOMOTE_AUTH_MICROSOFT_CLIENT_ID),
      botAppPassword: trimmed(env.ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET),
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
