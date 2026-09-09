import { describe, expect, it, vi, beforeEach } from 'vitest';
const { reconcile, syncStartedAt } = vi.hoisted(() => ({
  reconcile: vi.fn(async () => ({ ready: 0 })),
  syncStartedAt: vi.fn(async () => '2026-09-08T12:00:00.123456Z'),
}));
vi.mock('@roomote/sdk/server', () => ({
  reconcileSourceControlConnectionRequests: reconcile,
  getSourceControlSyncStartedAt: syncStartedAt,
}));

const { mockFindFirst, mockSyncGitHubInstallation } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockSyncGitHubInstallation: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: mockFindFirst,
      },
    },
  },
  githubInstallations: {
    installationId: 'installation_id',
  },
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));

vi.mock('@roomote/github', () => ({
  syncGitHubInstallation: mockSyncGitHubInstallation,
}));

import { handleInstallationRepositoriesChange } from '../handleInstallationRepositoriesChange';

describe('handleInstallationRepositoriesChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({ installedByUserId: 'user-1' });
    mockSyncGitHubInstallation.mockResolvedValue({
      success: true,
      githubInstallation: {},
      repositories: [
        { id: 'repo-1', fullName: 'org/one' },
        { id: 'repo-2', fullName: 'org/two' },
      ],
    });
  });

  it('resyncs the installation attributed to the installing user', async () => {
    const response = await handleInstallationRepositoriesChange({
      installation: { id: 42 },
    });

    expect(mockSyncGitHubInstallation).toHaveBeenCalledWith({
      userId: 'user-1',
      installationId: 42,
    });
    expect(response.status).toBe('ok');
    expect(response.metadata).toEqual({ repositoryCount: 2 });
    expect(syncStartedAt).toHaveBeenCalledWith('github');
    expect(syncStartedAt.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncGitHubInstallation.mock.invocationCallOrder[0]!,
    );
    expect(reconcile).toHaveBeenCalledWith(
      { provider: 'github' },
      {
        successfulSync: {
          startedAt: '2026-09-08T12:00:00.123456Z',
          repositoryFullNames: ['org/one', 'org/two'],
        },
      },
    );
  });

  it('short-circuits when the payload has no installation id', async () => {
    const response = await handleInstallationRepositoriesChange({});

    expect(response).toEqual({ status: 'ok', message: 'missing_installation' });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockSyncGitHubInstallation).not.toHaveBeenCalled();
  });

  it('short-circuits for installations this deployment has not synced', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const response = await handleInstallationRepositoriesChange({
      installation: { id: 42 },
    });

    expect(response).toEqual({ status: 'ok', message: 'unknown_installation' });
    expect(mockSyncGitHubInstallation).not.toHaveBeenCalled();
  });

  it('reports an error when the resync fails', async () => {
    mockSyncGitHubInstallation.mockResolvedValue({
      success: false,
      error: 'boom',
    });

    const response = await handleInstallationRepositoriesChange({
      installation: { id: 42 },
    });

    expect(response.status).toBe('error');
    expect(response.message).toContain('boom');
    expect(reconcile).not.toHaveBeenCalled();
  });
});
