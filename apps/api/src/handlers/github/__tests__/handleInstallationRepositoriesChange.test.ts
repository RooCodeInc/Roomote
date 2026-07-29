import { describe, expect, it, vi, beforeEach } from 'vitest';

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
      repositories: [{ id: 'repo-1' }, { id: 'repo-2' }],
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
  });
});
