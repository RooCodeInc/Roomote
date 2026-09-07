import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetPullRequestsForAnalytics,
  mockGetUpdatedPullRequestsForAnalytics,
  mockRepositoryRows,
  mockSyncStateRows,
  mockUpsertPullRequestFacts,
  mockUpsertPullRequestSyncState,
} = vi.hoisted(() => ({
  mockGetPullRequestsForAnalytics: vi.fn(),
  mockGetUpdatedPullRequestsForAnalytics: vi.fn(),
  mockRepositoryRows: vi.fn(),
  mockSyncStateRows: vi.fn(),
  mockUpsertPullRequestFacts: vi.fn(),
  mockUpsertPullRequestSyncState: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  getPullRequestsForAnalytics: mockGetPullRequestsForAnalytics,
  getUpdatedPullRequestsForAnalytics: mockGetUpdatedPullRequestsForAnalytics,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: { findMany: mockRepositoryRows },
      pullRequestSyncStates: { findMany: mockSyncStateRows },
    },
  },
  repositories: {
    isActive: 'repositories.isActive',
    sourceControlProvider: 'repositories.sourceControlProvider',
  },
  pullRequestSyncStates: {},
  githubInstallations: {},
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('../pull-request-facts-store', () => ({
  getLatestUpdatedAt: (
    pullRequests: Array<{ updatedAt: string }>,
    fallback: Date | null,
  ) =>
    pullRequests.reduce((latest, pullRequest) => {
      const updatedAt = new Date(pullRequest.updatedAt);
      return !latest || updatedAt > latest ? updatedAt : latest;
    }, fallback),
  upsertPullRequestFacts: mockUpsertPullRequestFacts,
  upsertPullRequestSyncState: mockUpsertPullRequestSyncState,
}));

import { syncGitHubPullRequestFactsForOrg } from '../github-pull-request-facts';

const NOW = new Date('2026-07-14T12:00:00Z');
const BOOTSTRAP_CREATED_AFTER = new Date('2026-06-01T00:00:00Z');

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    authorLogin: 'octocat',
    createdAt: '2026-07-01T00:00:00Z',
    externalPullRequestId: 900,
    updatedAt: '2026-07-10T00:00:00Z',
    closedAt: '2026-07-10T00:00:00Z',
    mergedAt: '2026-07-10T00:00:00Z',
    number: 42,
    repoFullName: 'acme/backend',
    state: 'merged' as const,
    title: 'Update backend',
    url: 'https://github.com/acme/backend/pull/42',
    ...overrides,
  };
}

describe('syncGitHubPullRequestFactsForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepositoryRows.mockResolvedValue([
      { id: 'repo-1', fullName: 'acme/backend' },
    ]);
    mockSyncStateRows.mockResolvedValue([]);
    mockUpsertPullRequestFacts.mockResolvedValue(undefined);
    mockUpsertPullRequestSyncState.mockResolvedValue(undefined);
  });

  it('forwards known descriptions and explicit empty labels to the facts store', async () => {
    mockGetPullRequestsForAnalytics.mockResolvedValue([
      pullRequest({ body: 'Why: the old path raced.', labels: [] }),
    ]);

    await syncGitHubPullRequestFactsForOrg({
      actorUserId: 'user-1',
      now: NOW,
      bootstrapCreatedAfter: BOOTSTRAP_CREATED_AFTER,
      repositoryIds: ['repo-1'],
    });

    expect(mockUpsertPullRequestFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequests: [
          expect.objectContaining({
            body: 'Why: the old path raced.',
            labels: [],
          }),
        ],
      }),
    );
  });

  it('normalizes omitted descriptions and labels to null', async () => {
    mockGetPullRequestsForAnalytics.mockResolvedValue([pullRequest()]);

    await syncGitHubPullRequestFactsForOrg({
      actorUserId: 'user-1',
      now: NOW,
      bootstrapCreatedAfter: BOOTSTRAP_CREATED_AFTER,
      repositoryIds: ['repo-1'],
    });

    expect(mockUpsertPullRequestFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequests: [
          expect.objectContaining({
            body: null,
            labels: null,
          }),
        ],
      }),
    );
  });
});
