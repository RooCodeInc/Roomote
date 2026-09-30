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
        repositoryNames: ['Acme/API'],
        config: { repositories: [] },
      },
    ]);

    await expect(
      buildRepositoryCoverage(['acme/api', 'acme/web']),
    ).resolves.toEqual([
      {
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'environment-1',
      },
      { repositoryFullName: 'acme/web' },
    ]);
  });

  it('preserves primary-then-specific environment selection', async () => {
    mockGetAvailableEnvironments.mockResolvedValue([
      {
        id: 'environment-specific',
        name: 'Specific',
        repositoryNames: ['acme/api'],
        config: { repositories: [{ repository: 'acme/api' }] },
      },
      {
        id: 'environment-primary',
        name: 'Primary',
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
        repositoryNames: ['acme/web', 'acme/api'],
        config: {
          repositories: [
            { repository: 'acme/web' },
            { repository: 'acme/api' },
          ],
        },
      },
    ]);

    await expect(buildRepositoryCoverage(['acme/api'])).resolves.toEqual([
      {
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'environment-specific',
      },
    ]);
  });
});
