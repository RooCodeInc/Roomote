import { buildSetupAuthStatus } from './setup-auth-config';

const REQUIRED_MICROSOFT_TEAMS_ENV_VARS = [
  'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
  'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
  'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
  'TEAMS_BOT_APP_ID',
  'TEAMS_BOT_APP_PASSWORD',
  'TEAMS_BOT_TENANT_ID',
];

describe('buildSetupAuthStatus', () => {
  it('treats runtime env as the highest-precedence satisfied setup source', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        SLACK_CLIENT_ID: 'runtime-client-id',
        SLACK_CLIENT_SECRET: 'runtime-client-secret',
        SLACK_SIGNING_SECRET: 'runtime-signing-secret',
      },
      persistedEnvVarNames: [
        'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
        'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
        'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
      ],
      selectedProvider: 'microsoft',
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.preselectedProvider).toBe('slack');
    expect(status.selectedProvider).toBe('microsoft');
    expect(status.runtimeConfiguredProvider).toBe('slack');
    expect(status.runtimeConfiguredProviders).toEqual(['slack']);
    expect(status.lockReason).toBe('runtime_env');
    expect(
      status.providers.find((provider) => provider.id === 'slack'),
    ).toMatchObject({
      runtimeSatisfied: true,
      savedSatisfied: false,
      setupSatisfied: true,
    });
  });

  it('satisfies Teams setup by inferring bot values from Microsoft sign-in values', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
        'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
        'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
      ],
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.preselectedProvider).toBe('microsoft');
    expect(status.selectedProvider).toBeNull();
    expect(status.runtimeConfiguredProvider).toBeNull();
    expect(status.runtimeConfiguredProviders).toEqual([]);
    expect(status.lockReason).toBeNull();
    expect(
      status.providers.find((provider) => provider.id === 'microsoft'),
    ).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: true,
      setupSatisfied: true,
    });
    expect(
      status.providers.find((provider) => provider.id === 'microsoft')?.fields,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          envVarName: 'TEAMS_BOT_APP_ID',
          savedSatisfied: true,
          satisfiedByEnvVarName: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
        }),
        expect.objectContaining({
          envVarName: 'TEAMS_BOT_APP_PASSWORD',
          savedSatisfied: true,
          satisfiedByEnvVarName: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
        }),
        expect.objectContaining({
          envVarName: 'TEAMS_BOT_TENANT_ID',
          savedSatisfied: true,
          satisfiedByEnvVarName: 'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
        }),
      ]),
    );
  });

  it('does not infer complete Teams setup from incomplete Microsoft sign-in values', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
        'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
      ],
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.preselectedProvider).toBe('slack');
    expect(status.selectedProvider).toBeNull();
    expect(status.runtimeConfiguredProvider).toBeNull();
    expect(status.runtimeConfiguredProviders).toEqual([]);
    expect(status.lockReason).toBeNull();
    expect(
      status.providers.find((provider) => provider.id === 'microsoft'),
    ).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: false,
      setupSatisfied: false,
    });
  });

  it('preselects the saved Teams provider when required sign-in and bot values exist', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: REQUIRED_MICROSOFT_TEAMS_ENV_VARS,
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.preselectedProvider).toBe('microsoft');
    expect(status.selectedProvider).toBeNull();
    expect(status.runtimeConfiguredProvider).toBeNull();
    expect(status.runtimeConfiguredProviders).toEqual([]);
    expect(status.lockReason).toBeNull();
    expect(
      status.providers.find((provider) => provider.id === 'microsoft'),
    ).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: true,
      setupSatisfied: true,
    });
  });

  it('resolves inferred Teams bot fields from the effective merged credential source', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        ROOMOTE_AUTH_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        ROOMOTE_AUTH_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
      },
      persistedEnvVarNames: [
        'TEAMS_BOT_APP_ID',
        'TEAMS_BOT_APP_PASSWORD',
        'TEAMS_BOT_TENANT_ID',
      ],
    });
    const microsoft = status.providers.find(
      (provider) => provider.id === 'microsoft',
    );

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.preselectedProvider).toBe('microsoft');
    expect(status.selectedProvider).toBeNull();
    expect(status.runtimeConfiguredProvider).toBeNull();
    expect(status.runtimeConfiguredProviders).toEqual([]);
    expect(status.lockReason).toBeNull();
    expect(microsoft).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: false,
      setupSatisfied: true,
    });
    expect(microsoft?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          envVarName: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
          runtimeSatisfied: true,
          savedSatisfied: false,
          satisfiedByEnvVarName: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
        }),
        expect.objectContaining({
          envVarName: 'TEAMS_BOT_APP_ID',
          runtimeSatisfied: false,
          savedSatisfied: true,
          satisfiedByEnvVarName: 'TEAMS_BOT_APP_ID',
        }),
        expect.objectContaining({
          envVarName: 'TEAMS_BOT_APP_PASSWORD',
          runtimeSatisfied: false,
          savedSatisfied: true,
          satisfiedByEnvVarName: 'TEAMS_BOT_APP_PASSWORD',
        }),
        expect.objectContaining({
          envVarName: 'TEAMS_BOT_TENANT_ID',
          runtimeSatisfied: false,
          savedSatisfied: true,
          satisfiedByEnvVarName: 'TEAMS_BOT_TENANT_ID',
        }),
      ]),
    );
  });

  it('honors Slack shared-credential fallback compatibility', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'ROOMOTE_AUTH_SLACK_CLIENT_ID',
        'ROOMOTE_AUTH_SLACK_CLIENT_SECRET',
        'SLACK_SIGNING_SECRET',
      ],
    });

    const slack = status.providers.find((provider) => provider.id === 'slack');

    expect(status.preselectedProvider).toBe('slack');
    expect(status.selectedProvider).toBeNull();
    expect(slack).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: true,
      setupSatisfied: true,
    });
    expect(slack?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          envVarName: 'SLACK_CLIENT_ID',
          satisfiedByEnvVarName: 'ROOMOTE_AUTH_SLACK_CLIENT_ID',
        }),
        expect.objectContaining({
          envVarName: 'SLACK_CLIENT_SECRET',
          satisfiedByEnvVarName: 'ROOMOTE_AUTH_SLACK_CLIENT_SECRET',
        }),
        expect.objectContaining({
          envVarName: 'SLACK_SIGNING_SECRET',
          satisfiedByEnvVarName: 'SLACK_SIGNING_SECRET',
        }),
      ]),
    );
  });

  it('does not ask for Slack App ID during auth setup', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'ROOMOTE_AUTH_SLACK_CLIENT_ID',
        'ROOMOTE_AUTH_SLACK_CLIENT_SECRET',
        'SLACK_SIGNING_SECRET',
      ],
    });

    const slack = status.providers.find((provider) => provider.id === 'slack');
    const slackAppIdField = slack?.fields.find(
      (field) => field.envVarName === 'SLACK_APP_ID',
    );

    expect(slack).toMatchObject({
      setupSatisfied: true,
    });
    expect(slackAppIdField).toBeUndefined();
  });

  it('does not treat a different runtime-configured provider as satisfying the selected provider', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        SLACK_CLIENT_ID: 'runtime-client-id',
        SLACK_CLIENT_SECRET: 'runtime-client-secret',
        SLACK_SIGNING_SECRET: 'runtime-signing-secret',
      },
      selectedProvider: 'microsoft',
    });

    expect(status.selectedProvider).toBe('microsoft');
    expect(status.preselectedProvider).toBe('slack');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
  });

  it('resolves multiple runtime-configured providers by catalog priority', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        SLACK_CLIENT_ID: 'runtime-client-id',
        SLACK_CLIENT_SECRET: 'runtime-client-secret',
        SLACK_SIGNING_SECRET: 'runtime-signing-secret',
        ROOMOTE_AUTH_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        ROOMOTE_AUTH_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
        TEAMS_BOT_APP_ID: 'teams-bot-app-id',
        TEAMS_BOT_APP_PASSWORD: 'teams-bot-app-password',
        TEAMS_BOT_TENANT_ID: 'teams-bot-tenant-id',
        TEAMS_BOT_TOKEN_ENDPOINT: 'https://login.example.test/token',
        TEAMS_BOT_OAUTH_SCOPE: 'https://api.botframework.com/.default',
      },
    });

    expect(status.runtimeConfiguredProvider).toBe('slack');
    expect(status.runtimeConfiguredProviders).toEqual(['slack', 'microsoft']);
    expect(status.selectedProvider).toBe('slack');
    expect(status.lockReason).toBe('runtime_env');
  });

  it('runtime-satisfies Teams setup from the Microsoft sign-in app when no dedicated bot pair is configured', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        ROOMOTE_AUTH_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        ROOMOTE_AUTH_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
      },
    });

    expect(status.runtimeConfiguredProvider).toBe('microsoft');
    expect(status.runtimeConfiguredProviders).toEqual(['microsoft']);
    expect(status.selectedProvider).toBe('microsoft');
    expect(status.preselectedProvider).toBe('microsoft');
    expect(status.lockReason).toBe('runtime_env');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
  });
});
