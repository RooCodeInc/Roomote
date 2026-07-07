import { buildSetupSourceControlStatus } from './setup-source-control-config';

describe('buildSetupSourceControlStatus', () => {
  it('counts a provider as setup-complete only when connected with repositories', () => {
    const status = buildSetupSourceControlStatus({
      runtimeEnv: {
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY: 'private-key',
        GITHUB_CLIENT_ID: 'client-id',
        GITHUB_CLIENT_SECRET: 'client-secret',
        GITHUB_WEBHOOK_SECRET: 'webhook-secret',
        NEXT_PUBLIC_GITHUB_APP_SLUG: 'roomote',
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
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY: 'private-key',
        GITHUB_CLIENT_ID: 'client-id',
        GITHUB_CLIENT_SECRET: 'client-secret',
        GITHUB_WEBHOOK_SECRET: 'webhook-secret',
        NEXT_PUBLIC_GITHUB_APP_SLUG: 'roomote',
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
      runtimeSatisfied: false,
      savedSatisfied: false,
    });
    expect(optionalAdoWebhookSecret).toMatchObject({
      required: false,
      secret: true,
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

  it('resolves saved satisfaction through accepted env var aliases', () => {
    const status = buildSetupSourceControlStatus({
      persistedEnvVarNames: ['GITHUB_APP_SLUG'],
    });

    const github = status.providers.find((p) => p.provider === 'github');
    const slugField = github?.fields.find(
      (f) => f.envVarName === 'NEXT_PUBLIC_GITHUB_APP_SLUG',
    );
    expect(slugField).toMatchObject({
      savedSatisfied: true,
      satisfiedByEnvVarName: 'GITHUB_APP_SLUG',
    });
  });

  it('prefers github when multiple providers are connected', () => {
    const status = buildSetupSourceControlStatus({
      connectedProviders: ['gitlab', 'github'],
      repositoryCounts: { gitlab: 3, github: 1 },
    });

    expect(status.connectedProvider).toBe('github');
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
