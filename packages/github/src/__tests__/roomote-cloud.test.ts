const { mockResolveDeploymentEnvVar } = vi.hoisted(() => ({
  mockResolveDeploymentEnvVar: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

import {
  createRoomoteCloudGitHubToken,
  resolveRoomoteCloudRuntimeConfig,
} from '../roomote-cloud';

describe('Roomote Cloud GitHub token broker', () => {
  beforeEach(() => {
    mockResolveDeploymentEnvVar.mockReset();
  });

  it('is disabled when neither runtime credential is configured', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue(null);

    await expect(resolveRoomoteCloudRuntimeConfig()).resolves.toBeNull();
  });

  it('ignores runtime credentials until the deployment opts in', async () => {
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) => {
      if (name === 'ROOMOTE_CLOUD_URL') return 'https://cloud.roomote.dev';
      if (name === 'ROOMOTE_CLOUD_DEPLOYMENT_TOKEN') return 'token';
      return null;
    });

    await expect(resolveRoomoteCloudRuntimeConfig()).resolves.toBeNull();
  });

  it('fails closed when only half of the runtime credential is configured', async () => {
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) => {
      if (name === 'ROOMOTE_CLOUD_ENABLED') return 'true';
      if (name === 'ROOMOTE_CLOUD_URL') return 'https://cloud.roomote.dev';
      return null;
    });

    await expect(resolveRoomoteCloudRuntimeConfig()).rejects.toThrow(
      'must be configured together',
    );
  });

  it('fails closed when Cloud is enabled without runtime credentials', async () => {
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'ROOMOTE_CLOUD_ENABLED' ? 'true' : null,
    );

    await expect(resolveRoomoteCloudRuntimeConfig()).rejects.toThrow(
      'must be configured together',
    );
  });

  it('requests a repository-scoped installation token', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        token: 'ghs_managed',
        expiresAt: '2026-07-14T18:00:00Z',
      }),
    );

    await expect(
      createRoomoteCloudGitHubToken({
        config: {
          baseUrl: 'https://cloud.roomote.dev',
          deploymentToken: 'deployment-secret',
        },
        installationId: 1234,
        repositoryIds: [10, 11],
        fetchFn,
      }),
    ).resolves.toEqual({
      token: 'ghs_managed',
      expiresAt: '2026-07-14T18:00:00Z',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      new URL('https://cloud.roomote.dev/runtime/v1/integrations/github/token'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: 'Bearer deployment-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          installationId: '1234',
          repositoryIds: [10, 11],
        }),
      }),
    );
  });

  it('preserves a reverse-proxy path when requesting a token', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        token: 'ghs_managed',
        expiresAt: '2026-07-14T18:00:00Z',
      }),
    );

    await createRoomoteCloudGitHubToken({
      config: {
        baseUrl: 'https://example.com/roomote-cloud',
        deploymentToken: 'deployment-secret',
      },
      installationId: 1234,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      new URL(
        'https://example.com/roomote-cloud/runtime/v1/integrations/github/token',
      ),
      expect.anything(),
    );
  });

  it('does not expose an upstream error body', async () => {
    await expect(
      createRoomoteCloudGitHubToken({
        config: {
          baseUrl: 'https://cloud.roomote.dev',
          deploymentToken: 'deployment-secret',
        },
        installationId: 1234,
        fetchFn: async () =>
          new Response('private upstream details', { status: 502 }),
      }),
    ).rejects.toThrow('HTTP 502');
  });
});
