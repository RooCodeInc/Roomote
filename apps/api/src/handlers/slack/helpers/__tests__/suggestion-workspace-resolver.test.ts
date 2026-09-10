import { resolveSuggestionLaunchWorkspaceFromMetadata } from '../suggestion-workspace-resolver.js';
import { ALL_REPOSITORIES } from '@roomote/types';

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

function setEnvironmentRows(
  rows: Array<{
    id: string;
    name: string;
    config: { repositories: Array<{ repository: string }> };
  }>,
): void {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async (count: number) => rows.slice(0, count)),
  };
  mockDbSelect.mockReturnValue(chain);
}

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    db: { select: mockDbSelect },
  };
});

describe('resolveSuggestionLaunchWorkspaceFromMetadata', () => {
  beforeEach(() => {
    mockDbSelect.mockReset();
  });

  it('derives the repository from a concrete target environment', async () => {
    setEnvironmentRows([
      {
        id: 'env-1',
        name: 'Env One',
        config: { repositories: [{ repository: 'roo/repo' }] },
      },
    ]);
    const result = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: null,
      targetEnvironmentId: 'env-1',
      readinessMessage: null,
    });

    expect(result.failureReason).toBeNull();
    expect(result.workspace).toEqual({
      repoForPayload: 'roo/repo',
      environmentId: 'env-1',
      workspaceDisplayName: 'Env One',
      readinessMessage: null,
    });
  });

  it('resolves the all-repositories sentinel without an environment lookup', async () => {
    const result = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: ALL_REPOSITORIES,
      targetEnvironmentId: null,
      readinessMessage: null,
    });

    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspace: {
        repoForPayload: ALL_REPOSITORIES,
        workspaceDisplayName: 'all repositories',
        readinessMessage: null,
      },
      failureReason: null,
    });
  });

  it('resolves a bare-repo workspace without an environment lookup', async () => {
    const result = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: 'roo/repo',
      targetEnvironmentId: null,
      readinessMessage: 'bare repo readiness',
    });

    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(result.failureReason).toBeNull();
    expect(result.workspace).toEqual({
      repoForPayload: 'roo/repo',
      workspaceDisplayName: 'roo/repo',
      readinessMessage: 'bare repo readiness',
    });
  });

  it('fails when the saved environment no longer exists', async () => {
    setEnvironmentRows([]);

    const result = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: 'roo/repo',
      targetEnvironmentId: 'env-1',
      readinessMessage: null,
    });

    expect(result.workspace).toBeNull();
    expect(result.failureReason).toContain(
      'environment is no longer available',
    );
  });

  it('fails when the environment no longer includes the target repository', async () => {
    setEnvironmentRows([
      {
        id: 'env-1',
        name: 'Env One',
        config: { repositories: [{ repository: 'roo/other' }] },
      },
    ]);

    const result = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: 'roo/repo',
      targetEnvironmentId: 'env-1',
      readinessMessage: null,
    });

    expect(result.workspace).toBeNull();
    expect(result.failureReason).toContain('no longer includes `roo/repo`');
  });

  it('resolves an environment-backed workspace when the repo is configured', async () => {
    setEnvironmentRows([
      {
        id: 'env-1',
        name: 'Env One',
        config: {
          repositories: [
            { repository: 'roo/other' },
            { repository: 'roo/repo' },
          ],
        },
      },
    ]);

    const result = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: 'Roo/Repo',
      targetEnvironmentId: 'env-1',
      readinessMessage: 'env readiness',
    });

    expect(result.failureReason).toBeNull();
    expect(result.workspace).toEqual({
      repoForPayload: 'Roo/Repo',
      environmentId: 'env-1',
      workspaceDisplayName: 'Env One',
      readinessMessage: 'env readiness',
    });
  });
});
