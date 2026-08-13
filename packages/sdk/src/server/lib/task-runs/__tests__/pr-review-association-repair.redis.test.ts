const mockFindManyTaskPullRequests = vi.fn();
const mockQueueAdd = vi.fn();
const mockTaskPullRequestUpsert = vi.fn();

vi.hoisted(() => {
  process.env.REDIS_URL ??= 'redis://localhost:16379';
});

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      query: {
        taskPullRequests: {
          findMany: (...args: unknown[]) =>
            mockFindManyTaskPullRequests(...args),
        },
      },
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoUpdate: async () => {
            await mockTaskPullRequestUpsert(values);
            mockFindManyTaskPullRequests.mockResolvedValue([
              { taskId: 'task-1' },
            ]);
          },
        }),
      }),
    },
  };
});

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

vi.mock('../slack-task-run-routing', () => ({
  resolveSlackTaskRunRouting: vi.fn(),
}));

import { getRedis } from '@roomote/redis';

import {
  enqueuePrReviewNotification,
  ORPHAN_REPLAY_REPAIR_DELAY_MS,
  repairOrphanPrReviewAssociationReplays,
  replayPrReviewNotificationAssociation,
} from '../pr-review-notification';
import { persistSourceControlPullRequestAssociation } from '../../pull-requests/source-control-pull-requests';

describe('orphan PR review association repair with Redis', () => {
  const redis = getRedis();
  const repository = `owner/association-repair-${process.pid}`;
  const prNumber = 42;
  const orphanKey = `pr-review-notification:orphan:github:${encodeURIComponent(repository)}#${prNumber}`;
  const markerKey = `pr-review-notification:orphan-replay:github:${encodeURIComponent(repository)}#${prNumber}`;
  const repairIndexKey = 'pr-review-notification:orphan-replay-repair';
  const repairMember = `github:${encodeURIComponent(repository)}#${prNumber}`;
  const repairPayloadKey = `pr-review-notification:orphan-replay-repair-payload:${repairMember}`;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockTaskPullRequestUpsert.mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue(undefined);
    await redis.del(orphanKey, markerKey, repairPayloadKey);
    await redis.zrem(repairIndexKey, repairMember);
  });

  afterAll(async () => {
    await redis.del(orphanKey, markerKey, repairPayloadKey);
    await redis.zrem(repairIndexKey, repairMember);
    await redis.quit();
  });

  it('recovers repeated post-association enqueue failures without another webhook and drains once', async () => {
    const input = {
      repository,
      prNumber,
      prUrl: `https://github.com/${repository}/pull/${prNumber}`,
      event: {
        kind: 'review' as const,
        authorLogin: 'alice',
        reviewState: 'changes_requested',
      },
    };

    await enqueuePrReviewNotification(input);
    mockQueueAdd.mockClear();

    mockQueueAdd
      .mockRejectedValueOnce(new Error('queue down'))
      .mockRejectedValueOnce(new Error('queue still down'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await expect(
      persistSourceControlPullRequestAssociation({
        taskRun: { taskId: 'task-1' } as never,
        result: {
          success: true,
          action: 'created',
          provider: 'github',
          repositoryFullName: repository,
          number: prNumber,
          url: `https://github.com/${repository}/pull/${prNumber}`,
          title: 'Review repair',
          targetBranch: 'develop',
          draft: true,
          warnings: [],
        },
        repository: {
          id: 1,
          sourceControlProvider: 'github',
          host: 'github.com',
        } as never,
      }),
    ).resolves.toBeNull();

    expect(mockTaskPullRequestUpsert).toHaveBeenCalledTimes(1);
    expect(await redis.llen(orphanKey)).toBe(1);
    expect(await redis.exists(markerKey)).toBe(0);
    expect(await redis.exists(repairPayloadKey)).toBe(1);
    expect(await redis.zscore(repairIndexKey, repairMember)).not.toBeNull();

    const repairNow = Date.now() + ORPHAN_REPLAY_REPAIR_DELAY_MS;
    await repairOrphanPrReviewAssociationReplays({ now: repairNow });
    expect(await redis.llen(orphanKey)).toBe(1);
    expect(await redis.exists(markerKey)).toBe(0);
    expect(await redis.exists(repairPayloadKey)).toBe(1);

    await repairOrphanPrReviewAssociationReplays({ now: repairNow });
    const replayCall = mockQueueAdd.mock.calls.at(-1);
    expect(replayCall?.[0]).toBe('replay-pr-review-association');
    const replayRequest = replayCall?.[1];

    await replayPrReviewNotificationAssociation(replayRequest);
    expect(await redis.exists(orphanKey)).toBe(0);
    expect(await redis.exists(markerKey)).toBe(0);
    expect(await redis.exists(repairPayloadKey)).toBe(0);
    expect(await redis.zscore(repairIndexKey, repairMember)).toBeNull();

    await replayPrReviewNotificationAssociation(replayRequest);
    expect(
      mockQueueAdd.mock.calls.filter(
        ([name]) => name === 'notify-pr-review-activity',
      ),
    ).toHaveLength(1);
  });

  it.each([
    { name: 'missing', stalePayload: null },
    { name: 'invalid', stalePayload: '{invalid' },
  ])(
    'preserves a newer repair intent during $name stale cleanup and recovers it',
    async ({ stalePayload }) => {
      const chainId = '00000000-0000-4000-8000-000000000002';
      const request = {
        kind: 'association_replay' as const,
        sourceControlProvider: 'github' as const,
        repository,
        prNumber,
        chainId,
        attempt: 1,
      };
      const newPayload = JSON.stringify(request);
      const repairNow = Date.now() + ORPHAN_REPLAY_REPAIR_DELAY_MS;
      const event = JSON.stringify({
        repository,
        prNumber,
        prUrl: `https://github.com/${repository}/pull/${prNumber}`,
        event: {
          kind: 'review',
          authorLogin: 'alice',
          reviewState: 'changes_requested',
        },
      });

      await redis.rpush(orphanKey, event);
      await redis.set(markerKey, `${chainId}:0`);
      if (stalePayload !== null) {
        await redis.set(repairPayloadKey, stalePayload);
      }
      await redis.zadd(repairIndexKey, repairNow, repairMember);

      const originalGet = redis.get.bind(redis);
      const getSpy = vi
        .spyOn(redis, 'get')
        .mockImplementationOnce(async (key) => {
          const staleValue = await originalGet(key);
          await redis
            .multi()
            .set(repairPayloadKey, newPayload, 'EX', 15 * 60)
            .zadd(repairIndexKey, repairNow, repairMember)
            .exec();
          return staleValue;
        });

      await repairOrphanPrReviewAssociationReplays({ now: repairNow });
      getSpy.mockRestore();

      expect(await redis.get(repairPayloadKey)).toBe(newPayload);
      expect(await redis.zscore(repairIndexKey, repairMember)).not.toBeNull();

      mockQueueAdd.mockRejectedValueOnce(new Error('queue still down'));
      await repairOrphanPrReviewAssociationReplays({ now: repairNow });
      expect(await redis.get(repairPayloadKey)).toBe(newPayload);
      expect(await redis.zscore(repairIndexKey, repairMember)).not.toBeNull();

      await repairOrphanPrReviewAssociationReplays({ now: repairNow });
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'replay-pr-review-association',
        request,
        { jobId: `association-replay-${chainId}-1` },
      );

      mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
      await replayPrReviewNotificationAssociation(request);
      expect(await redis.exists(orphanKey)).toBe(0);
      expect(await redis.exists(repairPayloadKey)).toBe(0);
      expect(await redis.zscore(repairIndexKey, repairMember)).toBeNull();
    },
  );
});
