const { resolveDeploymentEnvVarMock } = vi.hoisted(() => ({
  resolveDeploymentEnvVarMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { environmentVariables: { findMany: vi.fn() } } },
  resolveDeploymentEnvVar: resolveDeploymentEnvVarMock,
}));

import {
  getDeploymentStaticOauthReadiness,
  resolveDeploymentStaticOauthClientInformation,
} from './deployment-static-oauth';

const LINEAR_INTEGRATION = {
  id: 'linear',
  oauthClientEnv: {
    clientIdEnv: 'R_LINEAR_CLIENT_ID',
    clientSecretEnv: 'R_LINEAR_CLIENT_SECRET',
    tokenEndpointAuthMethod: 'client_secret_post' as const,
  },
};

describe('deployment static OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a client stored in the encrypted deployment environment', async () => {
    resolveDeploymentEnvVarMock.mockImplementation(async (name: string) =>
      name === 'R_LINEAR_CLIENT_ID' ? 'saved-client' : 'saved-secret',
    );

    await expect(
      resolveDeploymentStaticOauthClientInformation({}, LINEAR_INTEGRATION),
    ).resolves.toEqual({
      client_id: 'saved-client',
      client_secret: 'saved-secret',
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  it('reports a partially configured deployment', async () => {
    resolveDeploymentEnvVarMock.mockImplementation(async (name: string) =>
      name === 'R_LINEAR_CLIENT_ID' ? 'saved-client' : null,
    );

    await expect(
      getDeploymentStaticOauthReadiness({}, LINEAR_INTEGRATION),
    ).resolves.toBe('partial');
  });
});
