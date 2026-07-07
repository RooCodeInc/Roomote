import { buildSetupAuthStatus } from './setup-auth-config';

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

  it('preselects the saved provider when only persisted setup state exists', () => {
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
      },
    });

    expect(status.runtimeConfiguredProvider).toBe('slack');
    expect(status.runtimeConfiguredProviders).toEqual(['slack', 'microsoft']);
    expect(status.selectedProvider).toBe('slack');
    expect(status.lockReason).toBe('runtime_env');
  });
});
