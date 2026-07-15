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

  it('fails closed when only half of the runtime credential is configured', async () => {
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'ROOMOTE_CLOUD_URL' ? 'https://cloud.roomote.dev' : null,
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
