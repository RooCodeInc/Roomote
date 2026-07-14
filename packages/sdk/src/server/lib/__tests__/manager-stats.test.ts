import { describe, expect, it, vi } from 'vitest';

// The lib module imports the db, github, and provider-read packages at load
// time; stub them so the pure classification helpers can be exercised without
// a database or any network access. `isRoomoteGitHubLogin` is stubbed to
// recognize only `octomote[bot]` so the tests control the bot signal without
// slug resolution.
vi.mock('@roomote/db/server', () => ({
  db: {},
  repositories: {},
  taskPullRequests: {},
  tasks: {},
  users: {},
  eq: vi.fn(),
  gte: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: (login: string) => login === 'octomote[bot]',
  },
  resolveConfiguredGitHubAppSlug: vi.fn(),
  getPullRequestsForAnalytics: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock('../pull-requests/source-control-pull-request-reads', () => ({
  listOpenSourceControlPullRequestsForRepository: vi.fn(),
  listMergedSourceControlPullRequestsForRepository: vi.fn(),
}));

import {
  buildRoomotePullRequestMetadata,
  summarizeRoomotePullRequests,
  toAnalyticsPullRequests,
  type AnalyticsPullRequest,
} from '../manager-stats';
import type { SourceControlPullRequestSummary } from '../pull-requests/source-control-pull-request-reads';

type MetadataRow = Parameters<
  typeof buildRoomotePullRequestMetadata
>[0][number];

function metadataRow(overrides: Partial<MetadataRow>): MetadataRow {
  return {
    taskId: 'task-1',
    sourceControlProvider: 'github',
    repository: 'acme/app',
    prNumber: 1,
    workflow: 'standard',
    initiatorKind: 'user',
    initiatorUserId: 'user-1',
    initiatorAutomation: null,
    actorExternalId: null,
    actorDisplayName: null,
    userName: 'Ada Lovelace',
    userEmail: 'ada@example.com',
    ...overrides,
  };
}

describe('buildRoomotePullRequestMetadata', () => {
  it('classifies a pr_review workflow as reviewed and others as authored', () => {
    const metadata = buildRoomotePullRequestMetadata([
      metadataRow({
        repository: 'acme/app',
        prNumber: 1,
        workflow: 'standard',
      }),
      metadataRow({
        repository: 'acme/app',
        prNumber: 2,
        workflow: 'pr_review',
      }),
      metadataRow({
        repository: 'acme/app',
        prNumber: 3,
        workflow: 'setup_onboarding',
      }),
    ]);

    expect(metadata.get('github:acme/app#1')?.classification).toBe('authored');
    expect(metadata.get('github:acme/app#2')?.classification).toBe('reviewed');
    expect(metadata.get('github:acme/app#3')?.classification).toBe('authored');
  });

  it('lets authored win when a key has both authored and review rows', () => {
    // Review row first, then the authoring row.
    const reviewThenAuthor = buildRoomotePullRequestMetadata([
      metadataRow({
        taskId: 'review-task',
        prNumber: 7,
        workflow: 'pr_review',
      }),
      metadataRow({
        taskId: 'author-task',
        prNumber: 7,
        workflow: 'standard',
      }),
    ]);

    expect(reviewThenAuthor.get('github:acme/app#7')?.classification).toBe(
      'authored',
    );
    expect(reviewThenAuthor.get('github:acme/app#7')?.canonicalTaskId).toBe(
      'author-task',
    );

    // Authoring row first, then a review of the same PR must not demote it.
    const authorThenReview = buildRoomotePullRequestMetadata([
      metadataRow({
        taskId: 'author-task',
        prNumber: 7,
        workflow: 'standard',
      }),
      metadataRow({
        taskId: 'review-task',
        prNumber: 7,
        workflow: 'pr_review',
      }),
    ]);

    expect(authorThenReview.get('github:acme/app#7')?.classification).toBe(
      'authored',
    );
    expect(authorThenReview.get('github:acme/app#7')?.canonicalTaskId).toBe(
      'author-task',
    );
  });

  it('keys the same repository and number separately per provider', () => {
    const metadata = buildRoomotePullRequestMetadata([
      metadataRow({
        taskId: 'github-task',
        sourceControlProvider: 'github',
        prNumber: 9,
        workflow: 'standard',
      }),
      metadataRow({
        taskId: 'gitlab-task',
        sourceControlProvider: 'gitlab',
        prNumber: 9,
        workflow: 'pr_review',
      }),
    ]);

    expect(metadata.get('github:acme/app#9')?.classification).toBe('authored');
    expect(metadata.get('gitlab:acme/app#9')?.classification).toBe('reviewed');
    expect(metadata.get('gitlab:acme/app#9')?.canonicalTaskId).toBe(
      'gitlab-task',
    );
  });

  it('skips rows without a repository or PR number', () => {
    const metadata = buildRoomotePullRequestMetadata([
      metadataRow({ repository: null, prNumber: 1 }),
      metadataRow({ repository: 'acme/app', prNumber: null }),
    ]);

    expect(metadata.size).toBe(0);
  });
});

function analyticsPr(
  overrides: Partial<AnalyticsPullRequest>,
): AnalyticsPullRequest {
  return {
    sourceControlProvider: 'github',
    repoFullName: 'acme/app',
    number: 1,
    state: 'open',
    authorLogin: 'human-dev',
    ...overrides,
  };
}

describe('summarizeRoomotePullRequests', () => {
  it('classifies via workflow metadata and counts a bot-authored PR without a task row as authored', () => {
    const metadataByKey = buildRoomotePullRequestMetadata([
      metadataRow({ prNumber: 1, workflow: 'standard' }),
      metadataRow({ prNumber: 2, workflow: 'pr_review' }),
    ]);

    const { authored, reviewed, roomotePullRequests } =
      summarizeRoomotePullRequests({
        pullRequests: [
          analyticsPr({ number: 1 }), // authored via task metadata
          analyticsPr({ number: 2 }), // reviewed via task metadata
          // Bot-authored PR with no task row -> authored.
          analyticsPr({ number: 3, authorLogin: 'octomote[bot]' }),
          // Unrelated PR that Roomote never touched -> excluded.
          analyticsPr({ number: 4, authorLogin: 'human-dev' }),
        ],
        metadataByKey,
      });

    expect(roomotePullRequests).toHaveLength(3);
    expect(authored.map((entry) => entry.pullRequest.number).sort()).toEqual([
      1, 3,
    ]);
    expect(reviewed.map((entry) => entry.pullRequest.number)).toEqual([2]);
  });

  it('counts merged only for authored PRs', () => {
    const metadataByKey = buildRoomotePullRequestMetadata([
      metadataRow({ prNumber: 1, workflow: 'standard' }),
      metadataRow({ prNumber: 2, workflow: 'pr_review' }),
    ]);

    const { mergedAuthored } = summarizeRoomotePullRequests({
      pullRequests: [
        analyticsPr({ number: 1, state: 'merged' }), // authored + merged
        analyticsPr({ number: 2, state: 'merged' }), // reviewed + merged -> not Roomote's merge
        analyticsPr({
          number: 3,
          state: 'merged',
          authorLogin: 'octomote[bot]',
        }), // bot-authored + merged
      ],
      metadataByKey,
    });

    expect(
      mergedAuthored.map((entry) => entry.pullRequest.number).sort(),
    ).toEqual([1, 3]);
  });

  it('treats a bot-authored PR as authored even when a review task also touched it', () => {
    const metadataByKey = buildRoomotePullRequestMetadata([
      metadataRow({ prNumber: 5, workflow: 'pr_review' }),
    ]);

    const { authored, reviewed } = summarizeRoomotePullRequests({
      pullRequests: [analyticsPr({ number: 5, authorLogin: 'octomote[bot]' })],
      metadataByKey,
    });

    expect(authored.map((entry) => entry.pullRequest.number)).toEqual([5]);
    expect(reviewed).toHaveLength(0);
  });

  it('classifies non-GitHub PRs from task metadata only, never by author login', () => {
    const metadataByKey = buildRoomotePullRequestMetadata([
      metadataRow({
        sourceControlProvider: 'gitlab',
        prNumber: 1,
        workflow: 'standard',
      }),
      metadataRow({
        sourceControlProvider: 'ado',
        prNumber: 2,
        workflow: 'pr_review',
      }),
    ]);

    const { authored, reviewed, roomotePullRequests } =
      summarizeRoomotePullRequests({
        pullRequests: [
          analyticsPr({ sourceControlProvider: 'gitlab', number: 1 }),
          analyticsPr({ sourceControlProvider: 'ado', number: 2 }),
          // The GitHub bot login on a non-GitHub provider is someone else's
          // account name, not Roomote; without a task row it is excluded.
          analyticsPr({
            sourceControlProvider: 'gitea',
            number: 3,
            authorLogin: 'octomote[bot]',
          }),
        ],
        metadataByKey,
      });

    expect(roomotePullRequests).toHaveLength(2);
    expect(authored.map((entry) => entry.pullRequest.number)).toEqual([1]);
    expect(reviewed.map((entry) => entry.pullRequest.number)).toEqual([2]);
  });

  it('does not leak metadata across providers for the same repo and number', () => {
    const metadataByKey = buildRoomotePullRequestMetadata([
      metadataRow({
        sourceControlProvider: 'gitlab',
        prNumber: 6,
        workflow: 'standard',
      }),
    ]);

    const { roomotePullRequests } = summarizeRoomotePullRequests({
      pullRequests: [
        // Same repo full name and number, but on GitHub -> not Roomote's.
        analyticsPr({ sourceControlProvider: 'github', number: 6 }),
      ],
      metadataByKey,
    });

    expect(roomotePullRequests).toHaveLength(0);
  });
});

const WINDOW_START = new Date('2026-07-07T00:00:00.000Z');

function summary(
  overrides: Partial<SourceControlPullRequestSummary>,
): SourceControlPullRequestSummary {
  return {
    number: 1,
    externalId: null,
    url: 'https://example.com/pr/1',
    title: 'A change',
    state: 'open',
    draft: false,
    sourceBranch: 'feature',
    targetBranch: 'main',
    author: { id: '42', login: 'human-dev' },
    updatedAt: '2026-07-10T10:00:00.000Z',
    createdAt: '2026-07-10T09:00:00.000Z',
    mergedAt: null,
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

describe('toAnalyticsPullRequests', () => {
  it('maps GitLab-shaped summaries created inside the window', () => {
    const results = toAnalyticsPullRequests({
      provider: 'gitlab',
      repoFullName: 'group/app',
      summaries: [
        summary({ number: 1, createdAt: '2026-07-10T09:00:00.000Z' }),
        summary({
          number: 2,
          state: 'merged',
          createdAt: '2026-07-09T09:00:00.000Z',
          mergedAt: '2026-07-10T09:00:00.000Z',
        }),
        // Created before the window -> excluded even though still open.
        summary({ number: 3, createdAt: '2026-07-01T09:00:00.000Z' }),
      ],
      since: WINDOW_START,
    });

    expect(results).toEqual([
      {
        sourceControlProvider: 'gitlab',
        repoFullName: 'group/app',
        number: 1,
        state: 'open',
        authorLogin: 'human-dev',
      },
      {
        sourceControlProvider: 'gitlab',
        repoFullName: 'group/app',
        number: 2,
        state: 'merged',
        authorLogin: 'human-dev',
      },
    ]);
  });

  it('reports an open draft as draft, matching the GitHub analytics states', () => {
    const results = toAnalyticsPullRequests({
      provider: 'gitea',
      repoFullName: 'org/app',
      summaries: [summary({ number: 4, draft: true })],
      since: WINDOW_START,
    });

    expect(results[0]?.state).toBe('draft');
  });

  it('drops Bitbucket-shaped summaries without a created timestamp instead of guessing', () => {
    const results = toAnalyticsPullRequests({
      provider: 'bitbucket',
      repoFullName: 'workspace/app',
      summaries: [
        // Bitbucket merged lists carry no merge timestamp and, defensively,
        // a row may lack created_on too; unknown age must not count.
        summary({
          number: 5,
          state: 'merged',
          createdAt: null,
          mergedAt: null,
          updatedAt: '2026-07-11T09:00:00.000Z',
        }),
        summary({ number: 6, createdAt: '2026-07-11T09:00:00.000Z' }),
      ],
      since: WINDOW_START,
    });

    expect(results.map((pullRequest) => pullRequest.number)).toEqual([6]);
  });

  it('handles ADO-shaped summaries with null updatedAt and null author login', () => {
    const results = toAnalyticsPullRequests({
      provider: 'ado',
      repoFullName: 'org/project/repo',
      summaries: [
        summary({
          number: 7,
          state: 'merged',
          createdAt: '2026-07-12T09:00:00.000Z',
          mergedAt: '2026-07-13T09:00:00.000Z',
          updatedAt: null,
          author: null,
        }),
      ],
      since: WINDOW_START,
    });

    expect(results).toEqual([
      {
        sourceControlProvider: 'ado',
        repoFullName: 'org/project/repo',
        number: 7,
        state: 'merged',
        authorLogin: null,
      },
    ]);
  });

  it('dedupes summaries that report the same PR number twice', () => {
    const results = toAnalyticsPullRequests({
      provider: 'gitlab',
      repoFullName: 'group/app',
      summaries: [
        summary({ number: 8, state: 'open' }),
        summary({ number: 8, state: 'merged' }),
      ],
      since: WINDOW_START,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.state).toBe('open');
  });
});
