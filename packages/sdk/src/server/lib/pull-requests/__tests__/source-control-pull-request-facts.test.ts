import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  repositoriesTable,
  pullRequestFactsTable,
  pullRequestSyncStatesTable,
  mockRepositoryRows,
  mockSyncStateRows,
  mockInsert,
  mockListMergedPullRequests,
} = vi.hoisted(() => ({
  repositoriesTable: {
    id: 'repositories.id',
    sourceControlProvider: 'repositories.sourceControlProvider',
    host: 'repositories.host',
    installationId: 'repositories.installationId',
    externalRepoId: 'repositories.externalRepoId',
    fullName: 'repositories.fullName',
    htmlUrl: 'repositories.htmlUrl',
    isActive: 'repositories.isActive',
  },
  pullRequestFactsTable: {
    repositoryId: 'pullRequestFacts.repositoryId',
    prNumber: 'pullRequestFacts.prNumber',
  },
  pullRequestSyncStatesTable: {
    repositoryId: 'pullRequestSyncStates.repositoryId',
  },
  mockRepositoryRows: vi.fn(),
  mockSyncStateRows: vi.fn(),
  mockInsert: vi.fn(),
  mockListMergedPullRequests: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () =>
          table === repositoriesTable
            ? mockRepositoryRows()
            : mockSyncStateRows(),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: () => {
          mockInsert(table, values);
          return Promise.resolve();
        },
      }),
    })),
  },
  repositories: repositoriesTable,
  pullRequestFacts: pullRequestFactsTable,
  pullRequestSyncStates: pullRequestSyncStatesTable,
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({
    type: 'inArray',
    left,
    right,
  })),
  sql: vi.fn(),
}));

vi.mock('../source-control-pull-request-reads', () => ({
  listMergedSourceControlPullRequestsForRepository: (...args: unknown[]) =>
    mockListMergedPullRequests(...args),
}));

import {
  syncSourceControlPullRequestFacts,
  upsertSourceControlPullRequestFactFromWebhook,
} from '../source-control-pull-request-facts';

const NOW = new Date('2026-07-14T12:00:00Z');

function makeRepositoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'repo-1',
    sourceControlProvider: 'gitlab',
    host: null,
    installationId: null,
    externalRepoId: '101',
    fullName: 'acme/backend',
    htmlUrl: 'https://gitlab.com/acme/backend',
    ...overrides,
  };
}

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    externalId: 991,
    url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
    title: 'Merged MR',
    state: 'merged',
    draft: false,
    sourceBranch: 'feature/work',
    targetBranch: 'main',
    author: { id: '7', login: 'gitlab-user' },
    updatedAt: '2026-07-10T00:00:00Z',
    createdAt: '2026-06-30T00:00:00Z',
    mergedAt: '2026-07-10T00:00:00Z',
    closedAt: null,
    labels: [],
    headSha: null,
    baseSha: null,
    mergeable: null,
    mergeStateDescription: null,
    isCrossRepository: null,
    headRepositoryFullName: null,
    ...overrides,
  };
}

function factInserts() {
  return mockInsert.mock.calls.filter(
    ([table]) => table === pullRequestFactsTable,
  );
}

function syncStateInserts() {
  return mockInsert.mock.calls.filter(
    ([table]) => table === pullRequestSyncStatesTable,
  );
}

describe('syncSourceControlPullRequestFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepositoryRows.mockResolvedValue([makeRepositoryRow()]);
    mockSyncStateRows.mockResolvedValue([]);
    mockListMergedPullRequests.mockResolvedValue({
      success: true,
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      pullRequests: [makeSummary()],
      warnings: [],
    });
  });

  it('backfills merged PR facts for a repository without sync state', async () => {
    const result = await syncSourceControlPullRequestFacts({ now: NOW });

    expect(mockListMergedPullRequests).toHaveBeenCalledWith({
      repository: makeRepositoryRow(),
      provider: 'gitlab',
      limit: 200,
      updatedAfter: null,
    });

    const factValues = factInserts()[0]![1];
    expect(factValues).toEqual([
      {
        repositoryId: 'repo-1',
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'gitlab',
        externalPullRequestId: 991,
        prNumber: 42,
        title: 'Merged MR',
        htmlUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        authorLogin: 'gitlab-user',
        state: 'merged',
        createdAtRemote: new Date('2026-06-30T00:00:00Z'),
        updatedAtRemote: new Date('2026-07-10T00:00:00Z'),
        closedAtRemote: new Date('2026-07-10T00:00:00Z'),
        mergedAtRemote: new Date('2026-07-10T00:00:00Z'),
        syncedAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const syncStateValues = syncStateInserts()[0]![1];
    expect(syncStateValues).toMatchObject({
      repositoryId: 'repo-1',
      backfillCompletedAt: NOW,
      lastIncrementalUpdatedAt: new Date('2026-07-10T00:00:00Z'),
      lastSuccessfulSyncAt: NOW,
      cooldownUntil: null,
      lastErrorAt: null,
    });

    expect(result).toEqual({
      eligibleRepositories: 1,
      processedRepositories: 1,
      failedRepositories: 0,
      cooledDownRepositories: 0,
    });
  });

  it('passes the incremental cursor as updatedAfter once backfill completed', async () => {
    const cursor = new Date('2026-07-01T00:00:00Z');
    mockSyncStateRows.mockResolvedValue([
      {
        repositoryId: 'repo-1',
        backfillCompletedAt: new Date('2026-07-01T00:00:00Z'),
        lastIncrementalUpdatedAt: cursor,
        cooldownUntil: null,
        lastSuccessfulSyncAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);

    await syncSourceControlPullRequestFacts({ now: NOW });

    expect(mockListMergedPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAfter: cursor }),
    );

    const syncStateValues = syncStateInserts()[0]![1];
    // The cursor advances to the newest updatedAt among ingested PRs and the
    // backfill checkpoint is preserved.
    expect(syncStateValues).toMatchObject({
      lastIncrementalUpdatedAt: new Date('2026-07-10T00:00:00Z'),
      backfillCompletedAt: new Date('2026-07-01T00:00:00Z'),
    });
  });

  it('keeps the previous cursor when the incremental pass finds nothing', async () => {
    const cursor = new Date('2026-07-01T00:00:00Z');
    mockSyncStateRows.mockResolvedValue([
      {
        repositoryId: 'repo-1',
        backfillCompletedAt: new Date('2026-07-01T00:00:00Z'),
        lastIncrementalUpdatedAt: cursor,
        cooldownUntil: null,
        lastSuccessfulSyncAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);
    mockListMergedPullRequests.mockResolvedValue({
      success: true,
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      pullRequests: [],
      warnings: [],
    });

    await syncSourceControlPullRequestFacts({ now: NOW });

    expect(factInserts()).toHaveLength(0);
    const syncStateValues = syncStateInserts()[0]![1];
    expect(syncStateValues).toMatchObject({
      lastIncrementalUpdatedAt: cursor,
      lastSuccessfulSyncAt: NOW,
    });
  });

  it('skips repositories still cooling down', async () => {
    mockSyncStateRows.mockResolvedValue([
      {
        repositoryId: 'repo-1',
        backfillCompletedAt: null,
        lastIncrementalUpdatedAt: null,
        cooldownUntil: new Date('2026-07-14T13:00:00Z'),
        lastSuccessfulSyncAt: null,
      },
    ]);

    const result = await syncSourceControlPullRequestFacts({ now: NOW });

    expect(mockListMergedPullRequests).not.toHaveBeenCalled();
    expect(result.eligibleRepositories).toBe(0);
  });

  it('drops non-merged summaries and fills Bitbucket timestamp gaps from updatedAt', async () => {
    mockRepositoryRows.mockResolvedValue([
      makeRepositoryRow({
        id: 'repo-2',
        sourceControlProvider: 'bitbucket',
        externalRepoId: null,
      }),
    ]);
    mockListMergedPullRequests.mockResolvedValue({
      success: true,
      provider: 'bitbucket',
      repositoryFullName: 'acme/backend',
      pullRequests: [
        makeSummary({
          number: 7,
          externalId: null,
          mergedAt: null,
          closedAt: null,
          updatedAt: '2026-07-09T00:00:00Z',
        }),
        makeSummary({ number: 8, state: 'open' }),
      ],
      warnings: [],
    });

    await syncSourceControlPullRequestFacts({ now: NOW });

    const factValues = factInserts()[0]![1];
    expect(factValues).toEqual([
      expect.objectContaining({
        sourceControlProvider: 'bitbucket',
        prNumber: 7,
        externalPullRequestId: 7,
        mergedAtRemote: new Date('2026-07-09T00:00:00Z'),
        closedAtRemote: new Date('2026-07-09T00:00:00Z'),
        updatedAtRemote: new Date('2026-07-09T00:00:00Z'),
      }),
    ]);
  });

  it('records a rate-limit cooldown when the provider returns 429', async () => {
    mockListMergedPullRequests.mockRejectedValue(
      new Error('Source control API request failed: 429 Too Many Requests'),
    );

    const result = await syncSourceControlPullRequestFacts({ now: NOW });

    expect(result).toMatchObject({
      failedRepositories: 1,
      cooledDownRepositories: 1,
      processedRepositories: 0,
    });

    const syncStateValues = syncStateInserts()[0]![1];
    expect(syncStateValues).toMatchObject({
      cooldownUntil: new Date(NOW.getTime() + 15 * 60 * 1000),
      lastErrorAt: NOW,
      lastErrorMessage:
        'Source control API request failed: 429 Too Many Requests',
      lastSuccessfulSyncAt: null,
    });
  });

  it('records failures without a cooldown for non-rate-limit errors', async () => {
    mockListMergedPullRequests.mockRejectedValue(
      new Error('GITLAB_TOKEN is required to read GitLab merge requests.'),
    );

    const result = await syncSourceControlPullRequestFacts({ now: NOW });

    expect(result).toMatchObject({
      failedRepositories: 1,
      cooledDownRepositories: 0,
    });

    const syncStateValues = syncStateInserts()[0]![1];
    expect(syncStateValues).toMatchObject({ cooldownUntil: null });
  });
});

describe('upsertSourceControlPullRequestFactFromWebhook', () => {
  const snapshot = {
    authorLogin: 'gitea-user',
    closedAt: '2026-07-10T00:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
    externalPullRequestId: 900,
    mergedAt: '2026-07-10T00:00:00Z',
    number: 42,
    state: 'merged' as const,
    title: 'Update backend',
    updatedAt: '2026-07-10T00:00:00Z',
    url: 'https://git.example.com/acme/backend/pulls/42',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncStateRows.mockResolvedValue([]);
  });

  it('upserts a fact row for every matching active repository', async () => {
    mockRepositoryRows.mockResolvedValue([
      { repositoryId: 'repo-1', repositoryFullName: 'acme/backend' },
    ]);

    await upsertSourceControlPullRequestFactFromWebhook({
      provider: 'gitea',
      repositoryFullName: 'acme/backend',
      pullRequest: snapshot,
      now: NOW,
    });

    const factValues = factInserts()[0]![1];
    expect(factValues).toEqual([
      expect.objectContaining({
        repositoryId: 'repo-1',
        sourceControlProvider: 'gitea',
        prNumber: 42,
        state: 'merged',
        mergedAtRemote: new Date('2026-07-10T00:00:00Z'),
      }),
    ]);

    const syncStateValues = syncStateInserts()[0]![1];
    expect(syncStateValues).toMatchObject({
      repositoryId: 'repo-1',
      lastIncrementalUpdatedAt: new Date('2026-07-10T00:00:00Z'),
      lastSuccessfulSyncAt: NOW,
    });
  });

  it('never regresses an existing incremental cursor', async () => {
    mockRepositoryRows.mockResolvedValue([
      { repositoryId: 'repo-1', repositoryFullName: 'acme/backend' },
    ]);
    const laterCursor = new Date('2026-07-12T00:00:00Z');
    mockSyncStateRows.mockResolvedValue([
      {
        repositoryId: 'repo-1',
        lastIncrementalUpdatedAt: laterCursor,
        backfillCompletedAt: new Date('2026-07-01T00:00:00Z'),
        cooldownUntil: null,
      },
    ]);

    await upsertSourceControlPullRequestFactFromWebhook({
      provider: 'gitea',
      repositoryFullName: 'acme/backend',
      pullRequest: snapshot,
      now: NOW,
    });

    const syncStateValues = syncStateInserts()[0]![1];
    expect(syncStateValues).toMatchObject({
      lastIncrementalUpdatedAt: laterCursor,
      backfillCompletedAt: new Date('2026-07-01T00:00:00Z'),
    });
  });

  it('ignores GitHub, which is owned by the GitHub analytics sync', async () => {
    await upsertSourceControlPullRequestFactFromWebhook({
      provider: 'github',
      repositoryFullName: 'acme/backend',
      pullRequest: snapshot,
      now: NOW,
    });

    expect(mockRepositoryRows).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('is a no-op when no matching active repository exists', async () => {
    mockRepositoryRows.mockResolvedValue([]);

    await upsertSourceControlPullRequestFactFromWebhook({
      provider: 'gitea',
      repositoryFullName: 'acme/unknown',
      pullRequest: snapshot,
      now: NOW,
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });
});
