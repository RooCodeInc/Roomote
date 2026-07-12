import { describe, expect, it, vi } from 'vitest';

// The lib module imports the db and github packages at load time; stub them so
// the pure classification helpers can be exercised without a database or any
// GitHub network access. `isRoomoteGitHubLogin` is stubbed to recognize only
// `octomote[bot]` so the tests control the bot signal without slug resolution.
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
  getPullRequestsForAnalytics: vi.fn(),
  getPullRequest: vi.fn(),
}));

import {
  buildRoomotePullRequestMetadata,
  summarizeRoomotePullRequests,
} from '../manager-stats';

type MetadataRow = Parameters<
  typeof buildRoomotePullRequestMetadata
>[0][number];

function metadataRow(overrides: Partial<MetadataRow>): MetadataRow {
  return {
    taskId: 'task-1',
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

    expect(metadata.get('acme/app#1')?.classification).toBe('authored');
    expect(metadata.get('acme/app#2')?.classification).toBe('reviewed');
    expect(metadata.get('acme/app#3')?.classification).toBe('authored');
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

    expect(reviewThenAuthor.get('acme/app#7')?.classification).toBe('authored');
    expect(reviewThenAuthor.get('acme/app#7')?.canonicalTaskId).toBe(
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

    expect(authorThenReview.get('acme/app#7')?.classification).toBe('authored');
    expect(authorThenReview.get('acme/app#7')?.canonicalTaskId).toBe(
      'author-task',
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

type AnalyticsPr = Parameters<
  typeof summarizeRoomotePullRequests
>[0]['pullRequests'][number];

function analyticsPr(overrides: Partial<AnalyticsPr>): AnalyticsPr {
  return {
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
});
