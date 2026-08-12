const mockFindManyTaskPullRequests = vi.fn();
const mockQueueAdd = vi.fn();

vi.hoisted(() => {
  process.env.REDIS_URL ??= 'redis://localhost:6379';
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
  consumePendingPrReviewActivity,
  enqueuePrReviewNotification,
  repairPendingPrReviewNotificationJobs,
} from '../pr-review-notification';

describe('PR review notification repair with Redis', () => {
  const redis = getRedis();
  const taskId = `repair-batch-${process.pid}`;
  const repository = 'owner/repair-batch';
  const prNumber = 42;
  const target = {
    taskId,
    repository,
    prNumber,
    batchKind: 'human' as const,
  };
  const member = `${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}:human:delayed`;
  const pendingKey = `pr-review-notification:pending:${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}:human`;
  const delayedMarkerKey = `pr-review-notification:scheduled:${member}`;
  const immediateMarkerKey = `pr-review-notification:scheduled:${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}:human:immediate`;
  const repairIndexKey = 'pr-review-notification:repair';
  const repairPayloadKey = `pr-review-notification:repair-payload:${member}`;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId }]);
    mockQueueAdd.mockResolvedValue(undefined);
    await redis.del(
      pendingKey,
      delayedMarkerKey,
      immediateMarkerKey,
      repairPayloadKey,
    );
    await redis.zrem(repairIndexKey, member);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await redis.del(
      pendingKey,
      delayedMarkerKey,
      immediateMarkerKey,
      repairPayloadKey,
    );
    await redis.zrem(repairIndexKey, member);
    await redis.quit();
  });

  it('does not repair a multi-event batch after its original job consumes it', async () => {
    const baseInput = {
      repository,
      prNumber,
      prUrl: `https://github.com/${repository}/pull/${prNumber}`,
    };

    await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review',
        authorLogin: 'alice',
        reviewState: 'changes_requested',
      },
    });
    await enqueuePrReviewNotification({
      ...baseInput,
      event: { kind: 'review_comment', authorLogin: 'bob' },
    });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(await redis.llen(pendingKey)).toBe(2);
    expect(await redis.zscore(repairIndexKey, member)).not.toBeNull();
    await expect(consumePendingPrReviewActivity(target)).resolves.toHaveLength(
      2,
    );

    expect(await redis.exists(pendingKey)).toBe(0);
    expect(await redis.exists(repairPayloadKey)).toBe(0);
    expect(await redis.zscore(repairIndexKey, member)).toBeNull();
    expect(
      await redis.keys(
        `pr-review-notification:repair-payload:*${encodeURIComponent(taskId)}*`,
      ),
    ).toEqual([]);
    expect(
      (await redis.zrange(repairIndexKey, 0, -1)).filter((candidate) =>
        candidate.includes(encodeURIComponent(taskId)),
      ),
    ).toEqual([]);

    vi.setSystemTime(new Date('2026-08-12T20:02:00.000Z'));
    await repairPendingPrReviewNotificationJobs();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('still repairs a pending event after its original job fails to enqueue', async () => {
    mockQueueAdd
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce(undefined);

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

    await expect(enqueuePrReviewNotification(input)).rejects.toThrow(
      'queue down',
    );

    expect(await redis.llen(pendingKey)).toBe(1);
    expect(await redis.exists(repairPayloadKey)).toBe(1);
    expect(await redis.zscore(repairIndexKey, member)).not.toBeNull();

    vi.setSystemTime(new Date('2026-08-12T20:02:00.000Z'));
    await repairPendingPrReviewNotificationJobs();

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(await redis.llen(pendingKey)).toBe(1);
    expect(await redis.exists(repairPayloadKey)).toBe(0);
    expect(await redis.zscore(repairIndexKey, member)).toBeNull();
  });
});
