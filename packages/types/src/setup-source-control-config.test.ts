import {
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG,
  buildSetupSourceControlStatus,
  getSetupSourceControlVisibleFields,
} from './setup-source-control-config';

describe('buildSetupSourceControlStatus', () => {
  it('returns plain-text savedValue for non-secret fields only', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: {
        R_GITHUB_APP_SLUG: 'runtime-slug',
        R_GITHUB_APP_ID: '123',
        R_GITHUB_APP_PRIVATE_KEY: 'runtime-private-key',
      },
      persistedEnvVarNames: [
        'R_GITHUB_APP_SLUG',
        'R_GITHUB_APP_ID',
        'R_GITHUB_APP_PRIVATE_KEY',
        'R_GITHUB_CLIENT_ID',
      ],
      persistedEnvVarValues: {
        R_GITHUB_APP_SLUG: 'saved-slug',
        R_GITHUB_APP_ID: '999',
        R_GITHUB_APP_PRIVATE_KEY: 'should-never-surface',
        R_GITHUB_CLIENT_ID: 'saved-client-id',
      },
    });
    const github = status.providers.find(
      (provider) => provider.provider === 'github',
    );

    expect(
      github?.fields.find((field) => field.envVarName === 'R_GITHUB_APP_SLUG')
        ?.savedValue,
    ).toBe('runtime-slug');
    expect(
      github?.fields.find((field) => field.envVarName === 'R_GITHUB_CLIENT_ID')
        ?.savedValue,
    ).toBe('saved-client-id');
    expect(
      github?.fields.find(
        (field) => field.envVarName === 'R_GITHUB_APP_PRIVATE_KEY',
      )?.savedValue,
    ).toBeNull();
  });

  it('counts a provider as setup-complete only when connected with repositories', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: {
        R_GITHUB_APP_ID: '123',
        R_GITHUB_APP_PRIVATE_KEY: 'private-key',
        R_GITHUB_CLIENT_ID: 'client-id',
        R_GITHUB_CLIENT_SECRET: 'client-secret',
        R_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
        R_GITHUB_APP_SLUG: 'roomote',
      },
      connectedProviders: ['github'],
      repositoryCounts: { github: 4 },
    });

    expect(status.setupSatisfied).toBe(true);
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.connectedProvider).toBe('github');
    expect(status.preselectedProvider).toBe('github');
    expect(status.runtimeConfiguredProvider).toBe('github');
    expect(status.runtimeConfiguredProviders).toEqual(['github']);
    expect(status.lockReason).toBe('runtime_env');
    const github = status.providers.find((p) => p.provider === 'github');
    expect(github).toMatchObject({
      configSatisfied: true,
      configSatisfiedByRuntimeEnv: true,
      connected: true,
      repositoryCount: 4,
    });
  });

  it('does not mark setup satisfied when config is present but no repositories are connected', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: {
        GITLAB_TOKEN: 'gitlab-token',
      },
    });

    expect(status.setupSatisfied).toBe(false);
    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.connectedProvider).toBeNull();
    const gitlab = status.providers.find((p) => p.provider === 'gitlab');
    expect(gitlab).toMatchObject({
      configSatisfied: true,
      configSatisfiedByRuntimeEnv: true,
      connected: false,
      repositoryCount: 0,
    });
  });

  it('prefers a connected provider when preselecting even without runtime config', () => {
    const status = buildSetupSourceControlStatus({
      persistedEnvVarNames: ['GITLAB_TOKEN'],
      connectedProviders: ['gitlab'],
      repositoryCounts: { gitlab: 2 },
    });

    expect(status.preselectedProvider).toBe('gitlab');
    expect(status.connectedProvider).toBe('gitlab');
    const gitlab = status.providers.find((p) => p.provider === 'gitlab');
    expect(gitlab).toMatchObject({
      runtimeConfigSatisfied: false,
      savedConfigSatisfied: true,
      configSatisfied: true,
      connected: true,
      repositoryCount: 2,
    });
    expect(status.setupSatisfied).toBe(true);
    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
  });

  it('preselects the runtime-configured provider when nothing is connected', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: {
        GITEA_BASE_URL: 'https://gitea.example.com',
        GITEA_TOKEN: 'gitea-token',
      },
    });

    expect(status.preselectedProvider).toBe('gitea');
    expect(status.selectedProvider).toBe('gitea');
    expect(status.runtimeConfiguredProvider).toBe('gitea');
    expect(status.runtimeConfiguredProviders).toEqual(['gitea']);
    expect(status.lockReason).toBe('runtime_env');
    const gitea = status.providers.find((p) => p.provider === 'gitea');
    expect(gitea).toMatchObject({
      runtimeConfigSatisfied: true,
      configSatisfied: true,
      connected: false,
    });
  });

  it('honors the selected provider override', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: { GITLAB_TOKEN: 'gitlab-token' },
      selectedProvider: 'ado',
    });

    expect(status.selectedProvider).toBe('ado');
    expect(status.preselectedProvider).toBe('gitlab');
  });

  it('preselects saved config without locking or selecting the provider', () => {
    const status = buildSetupSourceControlStatus({
      persistedEnvVarNames: ['GITLAB_TOKEN'],
    });

    expect(status.preselectedProvider).toBe('gitlab');
    expect(status.selectedProvider).toBeNull();
    expect(status.runtimeConfiguredProvider).toBeNull();
    expect(status.runtimeConfiguredProviders).toEqual([]);
    expect(status.lockReason).toBeNull();
  });

  it('resolves multiple runtime-configured providers by source-control priority', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: {
        R_GITHUB_APP_ID: '123',
        R_GITHUB_APP_PRIVATE_KEY: 'private-key',
        R_GITHUB_CLIENT_ID: 'client-id',
        R_GITHUB_CLIENT_SECRET: 'client-secret',
        R_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
        R_GITHUB_APP_SLUG: 'roomote',
        GITLAB_TOKEN: 'gitlab-token',
      },
    });

    expect(status.runtimeConfiguredProvider).toBe('github');
    expect(status.runtimeConfiguredProviders).toEqual(['github', 'gitlab']);
    expect(status.selectedProvider).toBe('github');
    expect(status.lockReason).toBe('runtime_env');
  });

  it('does not require optional fields to satisfy config', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: {
        ADO_ORGANIZATION: 'my-org',
        ADO_TOKEN: 'ado-token',
      },
    });

    const ado = status.providers.find((p) => p.provider === 'ado');
    expect(ado).toMatchObject({ configSatisfied: true });
    const optionalBaseUrl = ado?.fields.find(
      (f) => f.envVarName === 'ADO_BASE_URL',
    );
    const optionalAdoWebhookSecret = ado?.fields.find(
      (f) => f.envVarName === 'ADO_WEBHOOK_SECRET',
    );
    const optionalAdoClientId = ado?.fields.find(
      (f) => f.envVarName === 'ADO_CLIENT_ID',
    );
    const optionalAdoClientSecret = ado?.fields.find(
      (f) => f.envVarName === 'ADO_CLIENT_SECRET',
    );
    const optionalAdoTenantId = ado?.fields.find(
      (f) => f.envVarName === 'ADO_TENANT_ID',
    );
    expect(optionalBaseUrl).toMatchObject({
      required: false,
      advanced: true,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
    expect(optionalAdoWebhookSecret).toMatchObject({
      required: false,
      secret: true,
      setupHidden: true,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
    expect(optionalAdoTenantId).toMatchObject({
      required: false,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
    expect(optionalAdoClientId).toMatchObject({
      required: false,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
    expect(optionalAdoClientSecret).toMatchObject({
      required: false,
      secret: true,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });

    const gitlabStatus = buildSetupSourceControlStatus({
      runtimeEnv: {
        GITLAB_TOKEN: 'gitlab-token',
      },
    });
    const gitlab = gitlabStatus.providers.find((p) => p.provider === 'gitlab');
    const optionalGitLabClientId = gitlab?.fields.find(
      (field) => field.envVarName === 'GITLAB_CLIENT_ID',
    );
    const optionalGitLabClientSecret = gitlab?.fields.find(
      (field) => field.envVarName === 'GITLAB_CLIENT_SECRET',
    );
    const giteaStatus = buildSetupSourceControlStatus({
      runtimeEnv: {
        GITEA_BASE_URL: 'https://gitea.example.com',
        GITEA_TOKEN: 'gitea-token',
      },
    });
    const gitea = giteaStatus.providers.find((p) => p.provider === 'gitea');
    const optionalGiteaWebhookSecret = gitea?.fields.find(
      (field) => field.envVarName === 'GITEA_WEBHOOK_SECRET',
    );

    expect(optionalGitLabClientId).toMatchObject({
      required: false,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
    expect(optionalGitLabClientSecret).toMatchObject({
      required: false,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
    expect(optionalGiteaWebhookSecret).toMatchObject({
      required: false,
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
  });

  it('does not mark delegated Azure DevOps setup complete without a linked account', () => {
    const incomplete = buildSetupSourceControlStatus({
      persistedEnvVarNames: [
        'ADO_ORGANIZATION',
        'ADO_AUTH_MODE',
        'ADO_CLIENT_ID',
        'ADO_CLIENT_SECRET',
        'ADO_TENANT_ID',
      ],
      persistedEnvVarValues: { ADO_AUTH_MODE: 'delegated' },
    });
    const complete = buildSetupSourceControlStatus({
      persistedEnvVarNames: [
        'ADO_ORGANIZATION',
        'ADO_AUTH_MODE',
        'ADO_LINKED_ACCOUNT_ID',
        'ADO_CLIENT_ID',
        'ADO_CLIENT_SECRET',
        'ADO_TENANT_ID',
      ],
      persistedEnvVarValues: {
        ADO_AUTH_MODE: 'delegated',
        ADO_LINKED_ACCOUNT_ID: 'ado-user@example.com',
      },
    });

    expect(
      incomplete.providers.find((provider) => provider.provider === 'ado'),
    ).toMatchObject({ configSatisfied: false });
    expect(
      complete.providers.find((provider) => provider.provider === 'ado'),
    ).toMatchObject({ configSatisfied: true });
  });

  it('marks config unsatisfied when a required field is missing', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: { ADO_ORGANIZATION: 'my-org' },
    });

    const ado = status.providers.find((p) => p.provider === 'ado');
    expect(ado).toMatchObject({ configSatisfied: false });
  });

  it('treats runtime env as the highest-precedence satisfaction source', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: { GITLAB_TOKEN: 'runtime-token' },
      persistedEnvVarNames: ['GITLAB_TOKEN'],
    });

    const gitlab = status.providers.find((p) => p.provider === 'gitlab');
    const tokenField = gitlab?.fields.find(
      (f) => f.envVarName === 'GITLAB_TOKEN',
    );
    expect(tokenField).toMatchObject({
      runtimeSatisfied: true,
      savedSatisfied: true,
      satisfiedByEnvVarName: 'GITLAB_TOKEN',
    });
  });

  it('resolves saved satisfaction through canonical env var names', () => {
    const status = buildSetupSourceControlStatus({
      persistedEnvVarNames: ['R_GITHUB_APP_SLUG'],
    });

    const github = status.providers.find((p) => p.provider === 'github');
    const slugField = github?.fields.find(
      (f) => f.envVarName === 'R_GITHUB_APP_SLUG',
    );
    expect(slugField).toMatchObject({
      savedSatisfied: true,
      satisfiedByEnvVarName: 'R_GITHUB_APP_SLUG',
    });
  });

  it('prefers github when multiple providers are connected', () => {
    const status = buildSetupSourceControlStatus({
      connectedProviders: ['gitlab', 'github'],
      repositoryCounts: { gitlab: 3, github: 1 },
    });

    expect(status.connectedProvider).toBe('github');
  });

  it('does not accept env var aliases in setup fields', () => {
    for (const provider of SETUP_SOURCE_CONTROL_PROVIDER_CATALOG) {
      for (const field of provider.fields) {
        expect(field.acceptedEnvVarNames).toEqual([field.envVarName]);
      }
    }
  });

  it('reports setup satisfied by runtime env when the connected provider is runtime-configured', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: { GITLAB_TOKEN: 'runtime-token' },
      persistedEnvVarNames: [],
      connectedProviders: ['gitlab'],
      repositoryCounts: { gitlab: 1 },
    });

    expect(status.setupSatisfied).toBe(true);
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
  });

  it('does not report setup satisfied by runtime env when the connected provider is only saved-configured', () => {
    const status = buildSetupSourceControlStatus({
      persistedEnvVarNames: ['GITLAB_TOKEN'],
      connectedProviders: ['gitlab'],
      repositoryCounts: { gitlab: 1 },
    });

    expect(status.setupSatisfied).toBe(true);
    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
  });
});

describe('getSetupSourceControlVisibleFields', () => {
  const ado = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
    (provider) => provider.provider === 'ado',
  );

  it('keeps mode-specific Azure DevOps credentials visible during setup', () => {
    expect(
      getSetupSourceControlVisibleFields(ado?.fields ?? []).map(
        (field) => field.envVarName,
      ),
    ).toEqual([
      'ADO_ORGANIZATION',
      'ADO_TOKEN',
      'ADO_CLIENT_ID',
      'ADO_CLIENT_SECRET',
      'ADO_TENANT_ID',
    ]);
  });

  it('includes optional Azure DevOps fields when advanced config is open', () => {
    expect(
      getSetupSourceControlVisibleFields(ado?.fields ?? [], {
        showAdvancedConfig: true,
      }).map((field) => field.envVarName),
    ).toEqual([
      'ADO_ORGANIZATION',
      'ADO_TOKEN',
      'ADO_BASE_URL',
      'ADO_USERNAME',
      'ADO_CLIENT_ID',
      'ADO_CLIENT_SECRET',
      'ADO_TENANT_ID',
    ]);
  });

  it('never returns the Azure DevOps webhook secret during setup', () => {
    const names = getSetupSourceControlVisibleFields(ado?.fields ?? [], {
      showAdvancedConfig: true,
    }).map((field) => field.envVarName);

    expect(names).not.toContain('ADO_WEBHOOK_SECRET');
  });

  it.each([
    ['gitlab', ['GITLAB_TOKEN', 'GITLAB_BASE_URL']],
    ['gitea', ['GITEA_BASE_URL', 'GITEA_TOKEN']],
    ['bitbucket', ['BITBUCKET_TOKEN', 'BITBUCKET_USERNAME']],
  ] as const)(
    'keeps %s setup focused on required connection values',
    (provider, expected) => {
      const descriptor = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
        (candidate) => candidate.provider === provider,
      );

      expect(
        getSetupSourceControlVisibleFields(descriptor?.fields ?? []).map(
          (field) => field.envVarName,
        ),
      ).toEqual(expected);
    },
  );
});
