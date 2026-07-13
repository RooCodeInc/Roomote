import {
  SETUP_AUTH_PROVIDER_CATALOG,
  buildSetupAuthStatus,
} from './setup-auth-config';

const REQUIRED_MICROSOFT_TEAMS_ENV_VARS = [
  'R_MICROSOFT_CLIENT_ID',
  'R_MICROSOFT_CLIENT_SECRET',
  'R_MICROSOFT_TENANT_ID',
  'R_TEAMS_BOT_APP_ID',
  'R_TEAMS_BOT_APP_PASSWORD',
  'R_TEAMS_BOT_TENANT_ID',
];

describe('buildSetupAuthStatus', () => {
  it('treats runtime env as the highest-precedence satisfied setup source', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        R_SLACK_CLIENT_ID: 'runtime-client-id',
        R_SLACK_CLIENT_SECRET: 'runtime-client-secret',
        R_SLACK_SIGNING_SECRET: 'runtime-signing-secret',
      },
      persistedEnvVarNames: [
        'R_MICROSOFT_CLIENT_ID',
        'R_MICROSOFT_CLIENT_SECRET',
        'R_MICROSOFT_TENANT_ID',
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
        'R_MICROSOFT_CLIENT_ID',
        'R_MICROSOFT_CLIENT_SECRET',
        'R_MICROSOFT_TENANT_ID',
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
          envVarName: 'R_TEAMS_BOT_APP_ID',
          savedSatisfied: true,
          satisfiedByEnvVarName: 'R_MICROSOFT_CLIENT_ID',
        }),
        expect.objectContaining({
          envVarName: 'R_TEAMS_BOT_APP_PASSWORD',
          savedSatisfied: true,
          satisfiedByEnvVarName: 'R_MICROSOFT_CLIENT_SECRET',
        }),
        expect.objectContaining({
          envVarName: 'R_TEAMS_BOT_TENANT_ID',
          savedSatisfied: true,
          satisfiedByEnvVarName: 'R_MICROSOFT_TENANT_ID',
        }),
      ]),
    );
  });

  it('does not infer complete Teams setup from incomplete Microsoft sign-in values', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'R_MICROSOFT_CLIENT_ID',
        'R_MICROSOFT_CLIENT_SECRET',
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
        R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
      },
      persistedEnvVarNames: [
        'R_TEAMS_BOT_APP_ID',
        'R_TEAMS_BOT_APP_PASSWORD',
        'R_TEAMS_BOT_TENANT_ID',
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
          envVarName: 'R_MICROSOFT_CLIENT_ID',
          runtimeSatisfied: true,
          savedSatisfied: false,
          satisfiedByEnvVarName: 'R_MICROSOFT_CLIENT_ID',
        }),
        expect.objectContaining({
          envVarName: 'R_TEAMS_BOT_APP_ID',
          runtimeSatisfied: false,
          savedSatisfied: true,
          satisfiedByEnvVarName: 'R_TEAMS_BOT_APP_ID',
        }),
        expect.objectContaining({
          envVarName: 'R_TEAMS_BOT_APP_PASSWORD',
          runtimeSatisfied: false,
          savedSatisfied: true,
          satisfiedByEnvVarName: 'R_TEAMS_BOT_APP_PASSWORD',
        }),
        expect.objectContaining({
          envVarName: 'R_TEAMS_BOT_TENANT_ID',
          runtimeSatisfied: false,
          savedSatisfied: true,
          satisfiedByEnvVarName: 'R_TEAMS_BOT_TENANT_ID',
        }),
      ]),
    );
  });

  it('honors saved Slack credentials with canonical names', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'R_SLACK_CLIENT_ID',
        'R_SLACK_CLIENT_SECRET',
        'R_SLACK_SIGNING_SECRET',
      ],
      persistedEnvVarValues: {
        R_SLACK_CLIENT_ID: 'saved-slack-client-id',
        R_SLACK_CLIENT_SECRET: 'should-never-surface',
      },
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
          envVarName: 'R_SLACK_CLIENT_ID',
          satisfiedByEnvVarName: 'R_SLACK_CLIENT_ID',
          savedValue: 'saved-slack-client-id',
        }),
        expect.objectContaining({
          envVarName: 'R_SLACK_CLIENT_SECRET',
          satisfiedByEnvVarName: 'R_SLACK_CLIENT_SECRET',
          savedValue: null,
        }),
        expect.objectContaining({
          envVarName: 'R_SLACK_SIGNING_SECRET',
          satisfiedByEnvVarName: 'R_SLACK_SIGNING_SECRET',
          savedValue: null,
        }),
      ]),
    );
  });

  it('returns plain-text savedValue for non-secret fields only', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        R_SLACK_CLIENT_ID: 'runtime-client-id',
        R_SLACK_CLIENT_SECRET: 'runtime-client-secret',
        R_SLACK_SIGNING_SECRET: 'runtime-signing-secret',
      },
      persistedEnvVarNames: [
        'R_SLACK_CLIENT_ID',
        'R_SLACK_CLIENT_SECRET',
        'R_SLACK_SIGNING_SECRET',
      ],
      persistedEnvVarValues: {
        R_SLACK_CLIENT_ID: 'saved-client-id',
        R_SLACK_CLIENT_SECRET: 'should-never-surface',
      },
    });
    const slack = status.providers.find((provider) => provider.id === 'slack');

    expect(
      slack?.fields.find((field) => field.envVarName === 'R_SLACK_CLIENT_ID')
        ?.savedValue,
    ).toBe('runtime-client-id');
    expect(
      slack?.fields.find(
        (field) => field.envVarName === 'R_SLACK_CLIENT_SECRET',
      )?.savedValue,
    ).toBeNull();
  });

  it('does not prefill inferred Teams bot savedValue from Microsoft sign-in values', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'R_MICROSOFT_CLIENT_ID',
        'R_MICROSOFT_CLIENT_SECRET',
        'R_MICROSOFT_TENANT_ID',
      ],
      persistedEnvVarValues: {
        R_MICROSOFT_CLIENT_ID: 'ms-client-id',
        R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
      },
    });
    const microsoft = status.providers.find(
      (provider) => provider.id === 'microsoft',
    );

    expect(
      microsoft?.fields.find(
        (field) => field.envVarName === 'R_MICROSOFT_CLIENT_ID',
      )?.savedValue,
    ).toBe('ms-client-id');
    expect(
      microsoft?.fields.find(
        (field) => field.envVarName === 'R_TEAMS_BOT_APP_ID',
      ),
    ).toMatchObject({
      savedSatisfied: true,
      savedValue: null,
      satisfiedByEnvVarName: 'R_MICROSOFT_CLIENT_ID',
    });
    expect(
      microsoft?.fields.find(
        (field) => field.envVarName === 'R_TEAMS_BOT_TENANT_ID',
      ),
    ).toMatchObject({
      savedSatisfied: true,
      savedValue: null,
      satisfiedByEnvVarName: 'R_MICROSOFT_TENANT_ID',
    });
  });

  it('does not ask for Slack App ID during auth setup', () => {
    const status = buildSetupAuthStatus({
      persistedEnvVarNames: [
        'R_SLACK_CLIENT_ID',
        'R_SLACK_CLIENT_SECRET',
        'R_SLACK_SIGNING_SECRET',
      ],
    });

    const slack = status.providers.find((provider) => provider.id === 'slack');
    const slackAppIdField = slack?.fields.find(
      (field) => field.envVarName === 'R_SLACK_APP_ID',
    );

    expect(slack).toMatchObject({
      setupSatisfied: true,
    });
    expect(slackAppIdField).toBeUndefined();
  });

  it('does not accept env var aliases in setup fields', () => {
    for (const provider of SETUP_AUTH_PROVIDER_CATALOG) {
      for (const field of provider.fields) {
        expect(field.acceptedEnvVarNames).toEqual([field.envVarName]);
      }
    }
  });

  it('does not treat a different runtime-configured provider as satisfying the selected provider', () => {
    const status = buildSetupAuthStatus({
      runtimeEnv: {
        R_SLACK_CLIENT_ID: 'runtime-client-id',
        R_SLACK_CLIENT_SECRET: 'runtime-client-secret',
        R_SLACK_SIGNING_SECRET: 'runtime-signing-secret',
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
        R_SLACK_CLIENT_ID: 'runtime-client-id',
        R_SLACK_CLIENT_SECRET: 'runtime-client-secret',
        R_SLACK_SIGNING_SECRET: 'runtime-signing-secret',
        R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
        R_TEAMS_BOT_APP_ID: 'teams-bot-app-id',
        R_TEAMS_BOT_APP_PASSWORD: 'teams-bot-app-password',
        R_TEAMS_BOT_TENANT_ID: 'teams-bot-tenant-id',
        R_TEAMS_BOT_TOKEN_ENDPOINT: 'https://login.example.test/token',
        R_TEAMS_BOT_OAUTH_SCOPE: 'https://api.botframework.com/.default',
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
        R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
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
