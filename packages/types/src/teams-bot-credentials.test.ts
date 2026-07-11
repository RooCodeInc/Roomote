import {
  resolveTeamsBotCredentialEnvVarNames,
  resolveTeamsBotRuntimeCredentialsFromEnv,
} from './teams-bot-credentials';

describe('resolveTeamsBotRuntimeCredentialsFromEnv', () => {
  it('prefers a complete R_TEAMS_BOT_* pair', () => {
    expect(
      resolveTeamsBotRuntimeCredentialsFromEnv({
        R_TEAMS_BOT_APP_ID: 'bot-id',
        R_TEAMS_BOT_APP_PASSWORD: 'bot-secret',
        R_TEAMS_BOT_TENANT_ID: 'bot-tenant',
        R_MICROSOFT_CLIENT_ID: 'signin-id',
        R_MICROSOFT_CLIENT_SECRET: 'signin-secret',
        R_MICROSOFT_TENANT_ID: 'signin-tenant',
      }),
    ).toEqual({
      botAppId: 'bot-id',
      botAppPassword: 'bot-secret',
      botTenantId: 'bot-tenant',
      botTokenEndpoint: null,
      botOauthScope: null,
      source: 'teams_bot',
    });
  });

  it('falls back to Microsoft sign-in when no dedicated bot pair is set', () => {
    expect(
      resolveTeamsBotRuntimeCredentialsFromEnv({
        R_MICROSOFT_CLIENT_ID: 'signin-id',
        R_MICROSOFT_CLIENT_SECRET: 'signin-secret',
        R_MICROSOFT_TENANT_ID: 'signin-tenant',
        R_TEAMS_BOT_TOKEN_ENDPOINT: 'https://login.example.test/token',
        R_TEAMS_BOT_OAUTH_SCOPE: 'https://api.botframework.com/.default',
      }),
    ).toEqual({
      botAppId: 'signin-id',
      botAppPassword: 'signin-secret',
      botTenantId: 'signin-tenant',
      botTokenEndpoint: 'https://login.example.test/token',
      botOauthScope: 'https://api.botframework.com/.default',
      source: 'microsoft_auth',
    });
  });

  it('does not mix a partial Teams bot id/password with Microsoft values', () => {
    expect(
      resolveTeamsBotRuntimeCredentialsFromEnv({
        R_TEAMS_BOT_APP_ID: 'bot-id',
        R_MICROSOFT_CLIENT_ID: 'signin-id',
        R_MICROSOFT_CLIENT_SECRET: 'signin-secret',
      }),
    ).toEqual({
      botAppId: 'signin-id',
      botAppPassword: 'signin-secret',
      botTenantId: null,
      botTokenEndpoint: null,
      botOauthScope: null,
      source: 'microsoft_auth',
    });
  });

  it('returns null credentials when neither source is complete', () => {
    expect(
      resolveTeamsBotRuntimeCredentialsFromEnv({
        R_TEAMS_BOT_APP_ID: 'bot-id',
        R_MICROSOFT_CLIENT_ID: 'signin-id',
      }),
    ).toEqual({
      botAppId: null,
      botAppPassword: null,
      botTenantId: null,
      botTokenEndpoint: null,
      botOauthScope: null,
      source: null,
    });
  });
});

describe('resolveTeamsBotCredentialEnvVarNames', () => {
  it('marks microsoft_auth as the source when only Microsoft vars are configured', () => {
    const configured = new Set([
      'R_MICROSOFT_CLIENT_ID',
      'R_MICROSOFT_CLIENT_SECRET',
      'R_MICROSOFT_TENANT_ID',
    ]);

    expect(
      resolveTeamsBotCredentialEnvVarNames({
        hasConfiguredEnvVar: (name) => configured.has(name),
      }),
    ).toEqual({
      source: 'microsoft_auth',
      fieldSourceEnvVarNames: {
        R_TEAMS_BOT_APP_ID: 'R_MICROSOFT_CLIENT_ID',
        R_TEAMS_BOT_APP_PASSWORD: 'R_MICROSOFT_CLIENT_SECRET',
        R_TEAMS_BOT_TENANT_ID: 'R_MICROSOFT_TENANT_ID',
      },
    });
  });
});
