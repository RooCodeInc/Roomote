import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAvailableEnvironments = vi.hoisted(() => vi.fn());

vi.mock('../available-environments', () => ({
  getAvailableEnvironments: mockGetAvailableEnvironments,
}));

import { buildRepositoryCoverage } from '../repository-environment-coverage';

describe('buildRepositoryCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses canonical shared repository mappings when config repositories are stale', async () => {
    mockGetAvailableEnvironments.mockResolvedValue([
      {
        id: 'environment-1',
        name: 'Shared environment',
        repositories: [{ id: 'repository-api', name: 'Acme/API' }],
        repositoryNames: ['Acme/API'],
        config: { repositories: [] },
      },
    ]);

    await expect(
      buildRepositoryCoverage([
        { repositoryId: 'repository-api', repositoryFullName: 'acme/api' },
        { repositoryId: 'repository-web', repositoryFullName: 'acme/web' },
      ]),
    ).resolves.toEqual([
      {
        repositoryId: 'repository-api',
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'environment-1',
      },
      { repositoryId: 'repository-web', repositoryFullName: 'acme/web' },
    ]);
  });

  it('preserves primary-then-specific environment selection', async () => {
    mockGetAvailableEnvironments.mockResolvedValue([
      {
        id: 'environment-specific',
        name: 'Specific',
        repositories: [{ id: 'repository-api', name: 'acme/api' }],
        repositoryNames: ['acme/api'],
        config: { repositories: [{ repository: 'acme/api' }] },
      },
      {
        id: 'environment-primary',
        name: 'Primary',
        repositories: [
          { id: 'repository-api', name: 'acme/api' },
          { id: 'repository-web', name: 'acme/web' },
        ],
        repositoryNames: ['acme/api', 'acme/web'],
        config: {
          repositories: [
            { repository: 'acme/api' },
            { repository: 'acme/web' },
          ],
        },
      },
      {
        id: 'environment-secondary',
        name: 'Secondary',
        repositories: [
          { id: 'repository-web', name: 'acme/web' },
          { id: 'repository-api', name: 'acme/api' },
        ],
        repositoryNames: ['acme/web', 'acme/api'],
        config: {
          repositories: [
            { repository: 'acme/web' },
            { repository: 'acme/api' },
          ],
        },
      },
    ]);

    await expect(
      buildRepositoryCoverage([
        { repositoryId: 'repository-api', repositoryFullName: 'acme/api' },
      ]),
    ).resolves.toEqual([
      {
        repositoryId: 'repository-api',
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'environment-specific',
      },
    ]);
  });

  it('does not cross-match same-name repositories from different providers or hosts', async () => {
    mockGetAvailableEnvironments.mockResolvedValue([
      {
        id: 'environment-github',
        name: 'GitHub environment',
        repositories: [{ id: 'repository-github', name: 'acme/api' }],
        repositoryNames: ['acme/api'],
        config: { repositories: [{ repository: 'acme/api' }] },
      },
      {
        id: 'environment-gitlab',
        name: 'GitLab environment',
        repositories: [{ id: 'repository-gitlab', name: 'acme/api' }],
        repositoryNames: ['acme/api'],
        config: { repositories: [{ repository: 'acme/api' }] },
      },
    ]);

    await expect(
      buildRepositoryCoverage([
        {
          repositoryId: 'repository-gitlab',
          repositoryFullName: 'acme/api',
        },
      ]),
    ).resolves.toEqual([
      {
        repositoryId: 'repository-gitlab',
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'environment-gitlab',
      },
    ]);
  });
});
