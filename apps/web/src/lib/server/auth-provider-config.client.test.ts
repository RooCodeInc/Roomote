const { mockBootstrapWebRuntimeEnv, mockResolveEffectiveDeploymentEnvVars } =
  vi.hoisted(() => ({
    mockBootstrapWebRuntimeEnv: vi.fn(),
    mockResolveEffectiveDeploymentEnvVars: vi.fn(),
  }));

vi.mock('./bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  resolveEffectiveDeploymentEnvVars: mockResolveEffectiveDeploymentEnvVars,
}));

vi.mock('./env', () => ({
  Env: {
    R_ALLOWED_EMAILS: undefined,
    R_APP_URL: 'http://localhost:3000',
  },
}));

import { resolveAuthProviderConfig } from './auth-provider-config';

describe('resolveAuthProviderConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables providers from saved deployment env vars', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
      deploymentEnvVars: {
        R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
      },
    });

    expect(config.enabledProviders).toEqual(['microsoft']);
    expect(config.microsoftClientId).toBe('microsoft-client-id');
    expect(config.microsoftClientSecret).toBe('microsoft-client-secret');
    expect(config.microsoftTenantId).toBe('microsoft-tenant-id');
    expect(mockBootstrapWebRuntimeEnv).not.toHaveBeenCalled();
  });

  it('resolves canonical Slack credentials', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
      deploymentEnvVars: {
        R_SLACK_CLIENT_ID: 'client-id',
        R_SLACK_CLIENT_SECRET: 'client-secret',
      },
    });

    expect(config.enabledProviders).toEqual(['slack']);
    expect(config.slackClientId).toBe('client-id');
    expect(config.slackClientSecret).toBe('client-secret');
  });

  it('resolves GitLab OAuth credentials without changing the setup auth provider list', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
      deploymentEnvVars: {
        GITLAB_CLIENT_ID: 'gitlab-client-id',
        GITLAB_CLIENT_SECRET: 'gitlab-client-secret',
        GITLAB_BASE_URL: 'https://gitlab.example.com',
      },
    });

    expect(config.enabledProviders).toEqual([]);
    expect(config.gitlabClientId).toBe('gitlab-client-id');
    expect(config.gitlabClientSecret).toBe('gitlab-client-secret');
    expect(config.gitlabBaseUrl).toBe('https://gitlab.example.com');
  });

  it('resolves Gitea OAuth credentials without changing the setup auth provider list', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
      deploymentEnvVars: {
        GITEA_CLIENT_ID: 'gitea-client-id',
        GITEA_CLIENT_SECRET: 'gitea-client-secret',
        GITEA_BASE_URL: 'https://gitea.example.com',
      },
    });

    expect(config.enabledProviders).toEqual([]);
    expect(config.giteaClientId).toBe('gitea-client-id');
    expect(config.giteaClientSecret).toBe('gitea-client-secret');
    expect(config.giteaBaseUrl).toBe('https://gitea.example.com');
  });

  it('prefers process env Gitea OAuth credentials over deployment env vars', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {
        GITEA_CLIENT_ID: 'runtime-client-id',
        GITEA_CLIENT_SECRET: 'runtime-client-secret',
        GITEA_BASE_URL: 'https://runtime.gitea.example.com',
      },
      deploymentEnvVars: {
        GITEA_CLIENT_ID: 'deployment-client-id',
        GITEA_CLIENT_SECRET: 'deployment-client-secret',
        GITEA_BASE_URL: 'https://deployment.gitea.example.com',
      },
    });

    expect(config.giteaClientId).toBe('runtime-client-id');
    expect(config.giteaClientSecret).toBe('runtime-client-secret');
    expect(config.giteaBaseUrl).toBe('https://runtime.gitea.example.com');
  });

  it('resolves Azure DevOps Entra credentials without changing the setup auth provider list', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
      deploymentEnvVars: {
        ADO_CLIENT_ID: 'ado-client-id',
        ADO_CLIENT_SECRET: 'ado-client-secret',
        ADO_TENANT_ID: 'ado-tenant-id',
        ADO_ORGANIZATION: 'ado-org',
        ADO_BASE_URL: 'https://dev.azure.example.com',
      },
    });

    expect(config.enabledProviders).toEqual([]);
    expect(config.adoClientId).toBe('ado-client-id');
    expect(config.adoClientSecret).toBe('ado-client-secret');
    expect(config.adoTenantId).toBe('ado-tenant-id');
    expect(config.adoOrganization).toBe('ado-org');
    expect(config.adoBaseUrl).toBe('https://dev.azure.example.com');
  });

  it('falls back to the Microsoft tenant for Azure DevOps Entra linking when no ADO tenant is configured', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
      deploymentEnvVars: {
        R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
        ADO_CLIENT_ID: 'ado-client-id',
        ADO_CLIENT_SECRET: 'ado-client-secret',
        ADO_ORGANIZATION: 'ado-org',
      },
    });

    expect(config.enabledProviders).toEqual([]);
    expect(config.adoTenantId).toBe('microsoft-tenant-id');
  });

  it('prefers the explicit ADO tenant over the Microsoft tenant fallback', async () => {
    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
      deploymentEnvVars: {
        R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
        ADO_TENANT_ID: 'ado-tenant-id',
        ADO_CLIENT_ID: 'ado-client-id',
        ADO_CLIENT_SECRET: 'ado-client-secret',
        ADO_ORGANIZATION: 'ado-org',
      },
    });

    expect(config.adoTenantId).toBe('ado-tenant-id');
  });

  it('bootstraps the web runtime before resolving default deployment env vars', async () => {
    mockResolveEffectiveDeploymentEnvVars.mockResolvedValue({
      R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
      R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
      R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
    });

    const config = await resolveAuthProviderConfig({
      runtimeEnv: {},
    });

    expect(mockBootstrapWebRuntimeEnv).toHaveBeenCalledTimes(1);
    expect(mockResolveEffectiveDeploymentEnvVars).toHaveBeenCalledWith({
      executor: {},
    });
    expect(config.enabledProviders).toEqual(['microsoft']);
  });
});
