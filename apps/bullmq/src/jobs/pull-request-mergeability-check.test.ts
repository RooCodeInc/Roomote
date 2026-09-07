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
  and: vi.fn(),
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
  buildPrReviewNotificationPostInput: (
    route: { channelId: string; threadId?: string | null },
    text: string,
  ) => ({
    channelId: route.channelId,
    ...(route.threadId ? { threadId: route.threadId } : {}),
    text,
    textFormat: 'markdown',
  }),
  buildPullRequestConflictMessage: (params: { title: string; url: string }) =>
    `[${params.title}](${params.url}) now has merge conflicts. Update the branch or ask Roomote to resolve them.`,
  enqueuePullRequestMergeabilityCheck: (...args: unknown[]) =>
    mocks.enqueue(...args),
  getCommunicationProviderAdapter: (...args: unknown[]) =>
    mocks.getAdapter(...args),
  notifyFastAgentParentOnPullRequestConflict: (...args: unknown[]) =>
    mocks.notifyFast(...args),
  pullRequestMergeabilityCheckRequestSchema: z.object({
    installationId: z.number(),
    repository: z.string(),
    baseRef: z.string().optional(),
    prNumber: z.number().optional(),
    taskPullRequestIds: z.array(z.string()).optional(),
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

type TestRequest = {
  installationId: number;
  repository: string;
  baseRef?: string;
  prNumber?: number;
  taskPullRequestIds?: string[];
  deduplicationKey: string;
  retryAttempt: 0 | 1;
  allowNotifiedConflictCheck: boolean;
};

const data: TestRequest = {
  installationId: 123,
  repository: 'owner/repo',
  baseRef: 'main',
  deduplicationKey: 'base:owner/repo:main',
  retryAttempt: 0,
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

    expect(mocks.list).toHaveBeenCalledWith({
      repository: 'owner/repo',
      baseRef: 'main',
      skipNotifiedConflicts: true,
    });
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
      installationId: 123,
      repository: 'owner/repo',
      taskPullRequestIds: [candidates[0]!.id],
      deduplicationKey: 'base:owner/repo:main',
      retryAttempt: 1,
      allowNotifiedConflictCheck: false,
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

  it('posts through the provider adapter for teams routes', async () => {
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
    mocks.record.mockResolvedValue({ shouldNotify: true, conflictDetectedAt });
    mocks.notifyFast.mockResolvedValue(false);
    mocks.resolveRoute.mockResolvedValue({
      provider: 'teams',
      channelId: 'teams-channel',
      threadId: 'teams-thread',
      serviceUrl: 'https://smba.example.com',
    });

    await pullRequestMergeabilityCheckJob({
      data,
    } as Job<typeof data, void, string>);

    expect(mocks.getAdapter).toHaveBeenCalledWith('teams');
    expect(mocks.postMessage).toHaveBeenCalled();
    expect(mocks.markNotified).toHaveBeenCalledOnce();
  });

  it('records the healthy aliases when one PR in the batch is unresolvable', async () => {
    const partialError = Object.assign(new Error('Could not resolve'), {
      name: 'GraphqlResponseError',
      data: {
        repository: {
          pr0: null,
          pr1: {
            number: 42,
            mergeable: 'MERGEABLE',
            state: 'OPEN',
            baseRefName: 'main',
          },
        },
      },
    });
    mocks.graphql.mockRejectedValue(partialError);

    await pullRequestMergeabilityCheckJob({
      data,
    } as Job<typeof data, void, string>);

    expect(mocks.record).toHaveBeenCalledWith({
      id: candidates[1]!.id,
      status: 'clean',
    });
    expect(mocks.record).not.toHaveBeenCalledWith({
      id: candidates[0]!.id,
      status: expect.anything(),
    });
  });

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
