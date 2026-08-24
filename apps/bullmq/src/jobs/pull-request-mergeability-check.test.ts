import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  enqueue: vi.fn(),
  getAdapter: vi.fn(),
  findRun: vi.fn(),
  findSlackInstallation: vi.fn(),
  graphql: vi.fn(),
  list: vi.fn(),
  markNotified: vi.fn(),
  notifyFast: vi.fn(),
  postMessage: vi.fn(),
  postSlack: vi.fn(),
  record: vi.fn(),
  recordHistory: vi.fn(),
  releaseClaim: vi.fn(),
  resolveRoute: vi.fn(),
  updateBaseRef: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: (...args: unknown[]) => mocks.findRun(...args) },
      slackInstallations: {
        findFirst: (...args: unknown[]) => mocks.findSlackInstallation(...args),
      },
    },
  },
  desc: vi.fn(),
  eq: vi.fn(),
  claimPullRequestConflictNotification: (...args: unknown[]) =>
    mocks.claim(...args),
  listTrackedPullRequestsForMergeability: (...args: unknown[]) =>
    mocks.list(...args),
  markPullRequestConflictNotified: (...args: unknown[]) =>
    mocks.markNotified(...args),
  recordPullRequestMergeability: (...args: unknown[]) => mocks.record(...args),
  releasePullRequestConflictNotificationClaim: (...args: unknown[]) =>
    mocks.releaseClaim(...args),
  slackInstallations: {},
  taskRuns: {},
  updateTrackedPullRequestBaseRef: (...args: unknown[]) =>
    mocks.updateBaseRef(...args),
}));

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: vi.fn(async () => ({ graphql: mocks.graphql })),
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueuePullRequestMergeabilityCheck: (...args: unknown[]) =>
    mocks.enqueue(...args),
  getCommunicationProviderAdapter: (...args: unknown[]) =>
    mocks.getAdapter(...args),
  notifyFastAgentParentOnPullRequestConflict: (...args: unknown[]) =>
    mocks.notifyFast(...args),
  pullRequestMergeabilityCheckRequestSchema: z.object({
    installationId: z.number(),
    repository: z.string(),
    taskPullRequestIds: z.array(z.string()),
    deduplicationKey: z.string(),
    retryAttempt: z.union([z.literal(0), z.literal(1)]),
    allowNotifiedConflictCheck: z.boolean(),
  }),
  recordPrReviewNotificationDeliveryBestEffort: (...args: unknown[]) =>
    mocks.recordHistory(...args),
  resolvePrReviewNotificationRoute: (...args: unknown[]) =>
    mocks.resolveRoute(...args),
}));

vi.mock('@roomote/slack', () => ({
  postSlackThreadMessageWithStickyFooter: (...args: unknown[]) =>
    mocks.postSlack(...args),
  SlackNotifier: class {},
}));

import type { Job } from 'bullmq';

import {
  buildPullRequestMergeabilityQuery,
  pullRequestMergeabilityCheckJob,
} from './pull-request-mergeability-check';

const candidates = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    taskId: 'task-1',
    repository: 'owner/repo',
    prNumber: 41,
    prUrl: 'https://github.com/owner/repo/pull/41',
    prTitle: 'First',
    prBaseRef: 'main',
    mergeabilityStatus: 'unknown' as const,
    conflictDetectedAt: null,
    conflictNotifiedAt: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    taskId: 'task-2',
    repository: 'owner/repo',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    prTitle: 'Second',
    prBaseRef: 'main',
    mergeabilityStatus: 'unknown' as const,
    conflictDetectedAt: null,
    conflictNotifiedAt: null,
  },
];

const data = {
  installationId: 123,
  repository: 'owner/repo',
  taskPullRequestIds: candidates.map((candidate) => candidate.id),
  deduplicationKey: 'base:owner/repo:main',
  retryAttempt: 0 as const,
  allowNotifiedConflictCheck: false,
};
const conflictNotificationClaimedAt = new Date('2026-08-24T23:00:01.000Z');

describe('pullRequestMergeabilityCheckJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(candidates);
    mocks.findRun.mockResolvedValue({
      id: 10,
      taskId: 'task-1',
      payload: { fastAgentParent: {} },
    });
    mocks.claim.mockResolvedValue(conflictNotificationClaimedAt);
    mocks.markNotified.mockResolvedValue(true);
    mocks.notifyFast.mockResolvedValue(true);
    mocks.getAdapter.mockResolvedValue({ postMessage: mocks.postMessage });
    mocks.findSlackInstallation.mockResolvedValue({ botAccessToken: 'token' });
    mocks.postMessage.mockResolvedValue({ messageId: 'discord-message' });
    mocks.postSlack.mockResolvedValue('123.456');
    mocks.recordHistory.mockResolvedValue(undefined);
    mocks.releaseClaim.mockResolvedValue(undefined);
    mocks.resolveRoute.mockResolvedValue(null);
    mocks.record.mockResolvedValue({
      shouldNotify: false,
      conflictDetectedAt: null,
    });
    mocks.updateBaseRef.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.graphql.mockResolvedValue({
      repository: {
        pr0: {
          number: 41,
          mergeable: 'UNKNOWN',
          state: 'OPEN',
          baseRefName: 'main',
        },
        pr1: {
          number: 42,
          mergeable: 'MERGEABLE',
          state: 'OPEN',
          baseRefName: 'main',
        },
      },
    });
  });

  it('fetches a branch batch in one aliased GraphQL call and retries only unknown PRs', async () => {
    await pullRequestMergeabilityCheckJob({ data } as Job<
      typeof data,
      void,
      string
    >);

    expect(mocks.graphql).toHaveBeenCalledOnce();
    const [query, variables] = mocks.graphql.mock.calls[0]!;
    expect(query).toContain(
      'pr0: pullRequest(number: $pr0) { number mergeable state baseRefName }',
    );
    expect(query).toContain(
      'pr1: pullRequest(number: $pr1) { number mergeable state baseRefName }',
    );
    expect(variables).toEqual({
      owner: 'owner',
      repo: 'repo',
      pr0: 41,
      pr1: 42,
    });
    expect(mocks.record).toHaveBeenCalledWith({
      id: candidates[0]!.id,
      status: 'unknown',
    });
    expect(mocks.record).toHaveBeenCalledWith({
      id: candidates[1]!.id,
      status: 'clean',
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      ...data,
      taskPullRequestIds: [candidates[0]!.id],
      deduplicationKey: 'base:owner/repo:main:unknown',
      retryAttempt: 1,
    });
  });

  it('builds variables instead of interpolating PR numbers into GraphQL', () => {
    const result = buildPullRequestMergeabilityQuery([7, 9]);
    expect(result.query).toContain('$pr0: Int!');
    expect(result.query).toContain('pullRequest(number: $pr1)');
    expect(result.variables).toEqual({ pr0: 7, pr1: 9 });
  });

  it('delivers and marks a durable transition into conflicting', async () => {
    const conflictDetectedAt = new Date('2026-08-24T23:00:00.000Z');
    mocks.list.mockResolvedValue([candidates[0]]);
    mocks.graphql.mockResolvedValue({
      repository: {
        pr0: {
          number: 41,
          mergeable: 'CONFLICTING',
          state: 'OPEN',
          baseRefName: 'main',
        },
      },
    });
    mocks.record.mockResolvedValue({
      shouldNotify: true,
      conflictDetectedAt,
    });

    await pullRequestMergeabilityCheckJob({
      data: { ...data, taskPullRequestIds: [candidates[0]!.id] },
    } as Job<typeof data, void, string>);

    expect(mocks.notifyFast).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictDetectedAt,
        pullRequest: expect.objectContaining({
          repository: 'owner/repo',
          number: 41,
        }),
      }),
    );
    expect(mocks.markNotified).toHaveBeenCalledWith({
      id: candidates[0]!.id,
      conflictDetectedAt,
      conflictNotificationClaimedAt,
    });
  });

  it.each([
    {
      provider: 'discord' as const,
      route: {
        provider: 'discord' as const,
        channelId: 'discord-channel',
        threadId: 'discord-thread',
      },
    },
    {
      provider: 'slack' as const,
      route: {
        provider: 'slack' as const,
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '100.001',
      },
    },
  ])(
    'posts the conflict message to the originating $provider thread',
    async ({ provider, route }) => {
      const conflictDetectedAt = new Date('2026-08-24T23:00:00.000Z');
      mocks.list.mockResolvedValue([candidates[0]]);
      mocks.graphql.mockResolvedValue({
        repository: {
          pr0: {
            number: 41,
            mergeable: 'CONFLICTING',
            state: 'OPEN',
            baseRefName: 'main',
          },
        },
      });
      mocks.record.mockResolvedValue({
        shouldNotify: true,
        conflictDetectedAt,
      });
      mocks.notifyFast.mockResolvedValue(false);
      mocks.resolveRoute.mockResolvedValue(route);

      await pullRequestMergeabilityCheckJob({
        data: { ...data, taskPullRequestIds: [candidates[0]!.id] },
      } as Job<typeof data, void, string>);

      const text =
        '[First](https://github.com/owner/repo/pull/41) now has merge conflicts. Update the branch or ask Roomote to resolve them.';
      if (provider === 'discord') {
        expect(mocks.postMessage).toHaveBeenCalledWith({
          channelId: 'discord-channel',
          threadId: 'discord-thread',
          text,
          textFormat: 'markdown',
        });
      } else {
        expect(mocks.postSlack).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: 'C123',
            threadTs: '100.001',
            text,
            blocks: [{ type: 'markdown', text }],
          }),
        );
      }
      expect(mocks.recordHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          text,
          source: 'pr_conflict_notification',
        }),
      );
      expect(mocks.markNotified).toHaveBeenCalledWith({
        id: candidates[0]!.id,
        conflictDetectedAt,
        conflictNotificationClaimedAt,
      });
    },
  );

  it('allows only one concurrent job to claim a conflict notification', async () => {
    const conflictDetectedAt = new Date('2026-08-24T23:00:00.000Z');
    mocks.list.mockResolvedValue([candidates[0]]);
    mocks.graphql.mockResolvedValue({
      repository: {
        pr0: {
          number: 41,
          mergeable: 'CONFLICTING',
          state: 'OPEN',
          baseRefName: 'main',
        },
      },
    });
    mocks.record.mockResolvedValue({
      shouldNotify: true,
      conflictDetectedAt,
    });
    mocks.claim
      .mockResolvedValueOnce(conflictNotificationClaimedAt)
      .mockResolvedValueOnce(null);

    await Promise.all([
      pullRequestMergeabilityCheckJob({
        data: { ...data, taskPullRequestIds: [candidates[0]!.id] },
      } as Job<typeof data, void, string>),
      pullRequestMergeabilityCheckJob({
        data: { ...data, taskPullRequestIds: [candidates[0]!.id] },
      } as Job<typeof data, void, string>),
    ]);

    expect(mocks.notifyFast).toHaveBeenCalledOnce();
    expect(mocks.markNotified).toHaveBeenCalledOnce();
  });
});
