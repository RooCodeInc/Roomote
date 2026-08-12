const mockFindManyTaskPullRequests = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisEval = vi.fn();
const mockQueueAdd = vi.fn();
const mockMultiExec = vi.fn();
const mockResolveSlackTaskRunRouting = vi.fn();
const multiCalls: Array<{ command: string; args: unknown[] }> = [];
const replayChainId = '00000000-0000-4000-8000-000000000001';
let orphanChainId = replayChainId;
let orphanRevision = 0;

function createMultiMock() {
  const multi: Record<string, unknown> = {};

  for (const command of ['rpush', 'expire', 'lrange', 'del']) {
    multi[command] = (...args: unknown[]) => {
      multiCalls.push({ command, args });
      return multi;
    };
  }

  multi.exec = (...args: unknown[]) => mockMultiExec(...args);

  return multi;
}

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

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    eval: (...args: unknown[]) => mockRedisEval(...args),
    multi: () => createMultiMock(),
  }),
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

vi.mock('../slack-task-run-routing', () => ({
  resolveSlackTaskRunRouting: (...args: unknown[]) =>
    mockResolveSlackTaskRunRouting(...args),
}));

import {
  PR_REVIEW_NOTIFICATION_DEBOUNCE_MS,
  PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS,
  consumePendingPrReviewActivity,
  enqueuePrReviewNotification,
  formatPrReviewActivityMessage,
  hasPrReviewNotificationThreadContext,
  resolvePrReviewNotificationRoute,
  replayPrReviewNotificationAssociation,
  startPrReviewNotificationCycle,
  wakePrReviewNotificationAssociation,
} from '../pr-review-notification';

describe('enqueuePrReviewNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    multiCalls.length = 0;
    orphanChainId = replayChainId;
    orphanRevision = 0;

    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
    mockRedisEval.mockImplementation((script: string, ...args: unknown[]) => {
      if (script.includes("marker = ARGV[1] .. ':0'")) {
        return mockRedisGet(...args);
      }
      if (script.includes("redis.call('RPUSH', KEYS[1], ARGV[2])")) {
        const claimed = orphanRevision === 0 ? 1 : 0;
        orphanRevision += 1;
        orphanChainId = claimed === 1 ? String(args[3]) : orphanChainId;
        return Promise.resolve([`${orphanChainId}:${orphanRevision}`, claimed]);
      }

      if (script.includes('release a quiet chain')) {
        return Promise.resolve(0);
      }

      if (script.includes("marker = ARGV[1] .. ':0'")) {
        return mockRedisGet(...args);
      }

      if (script.includes("redis.call('LLEN', KEYS[1])")) {
        return Promise.resolve(0);
      }

      return Promise.resolve(1);
    });
    mockQueueAdd.mockResolvedValue(undefined);
    mockMultiExec.mockResolvedValue([]);
  });

  const baseInput = {
    repository: 'owner/repo',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    event: {
      kind: 'review' as const,
      authorLogin: 'alice',
      reviewState: 'changes_requested',
    },
  };

  it('schedules a delayed association replay before returning no_linked_tasks', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);

    const result = await enqueuePrReviewNotification(baseInput);

    expect(result).toEqual({ notifiedTaskCount: 0, reason: 'no_linked_tasks' });
    expect(mockFindManyTaskPullRequests).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'replay-pr-review-association',
      {
        kind: 'association_replay',
        sourceControlProvider: 'github',
        repository: 'owner/repo',
        prNumber: 42,
        chainId: expect.any(String),
        attempt: 1,
      },
      {
        delay: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS[0],
        jobId: expect.stringMatching(/^association-replay-[a-f0-9-]+-1$/),
      },
    );
  });

  it('atomically claims retained activity and schedules attempt 1 on association commit', async () => {
    mockRedisEval.mockResolvedValueOnce(1);

    await expect(
      wakePrReviewNotificationAssociation({
        sourceControlProvider: 'github',
        repository: 'owner/repo',
        prNumber: 42,
      }),
    ).resolves.toBe(true);

    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('LLEN', KEYS[1])"),
      2,
      'pr-review-notification:orphan:github:owner%2Frepo#42',
      'pr-review-notification:orphan-replay:github:owner%2Frepo#42',
      expect.any(String),
      900,
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'replay-pr-review-association',
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({
        delay: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS[0],
      }),
    );
  });

  it('lets association commit wake the list after final replay releases it', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockRedisEval
      .mockResolvedValueOnce(`${replayChainId}:1`)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    await replayPrReviewNotificationAssociation({
      kind: 'association_replay',
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      chainId: replayChainId,
      attempt: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length,
    });
    await wakePrReviewNotificationAssociation({
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
    });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'replay-pr-review-association',
      expect.objectContaining({ attempt: 1 }),
      expect.any(Object),
    );
  });

  it('preserves legacy GitHub pending and scheduled key identity', async () => {
    await enqueuePrReviewNotification(baseInput);

    expect(multiCalls).toContainEqual({
      command: 'rpush',
      args: [
        'pr-review-notification:pending:task-1:owner%2Frepo#42:human',
        expect.any(String),
      ],
    });
    expect(mockRedisSet).toHaveBeenCalledWith(
      'pr-review-notification:scheduled:task-1:owner%2Frepo#42:human:delayed',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('namespaces non-default provider pending and scheduled keys', async () => {
    await enqueuePrReviewNotification({
      ...baseInput,
      sourceControlProvider: 'gitlab',
    });

    expect(multiCalls).toContainEqual({
      command: 'rpush',
      args: [
        'pr-review-notification:pending:gitlab:task-1:owner%2Frepo#42:human',
        expect.any(String),
      ],
    });
    expect(mockRedisSet).toHaveBeenCalledWith(
      'pr-review-notification:scheduled:gitlab:task-1:owner%2Frepo#42:human:delayed',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('coalesces an unrelated PR burst into one replay chain without dropping events', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockRedisSet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValueOnce('OK');
    mockRedisGet.mockResolvedValue(`${replayChainId}:50`);

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        enqueuePrReviewNotification({
          ...baseInput,
          event: {
            kind: 'review_comment',
            authorLogin: 'reviewer',
            batchId: `github-review:${index}`,
            url: `https://github.com/owner/repo/pull/42#discussion-${index}`,
          },
        }),
      ),
    );

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(orphanRevision).toBe(50);
  });

  it('retains every orphan event when association persistence finishes before replay', async () => {
    const orphanInputs = [
      baseInput,
      {
        ...baseInput,
        event: {
          kind: 'review_comment' as const,
          authorLogin: 'bob',
          batchId: 'github-review:2',
        },
      },
    ];
    mockFindManyTaskPullRequests
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ taskId: 'task-1' }]);

    await enqueuePrReviewNotification(baseInput);
    mockQueueAdd.mockClear();
    multiCalls.length = 0;
    mockRedisEval.mockImplementation((script: string, ...args: unknown[]) => {
      if (script.includes("marker = ARGV[1] .. ':0'")) {
        return Promise.resolve(`${replayChainId}:1`);
      }
      if (script.includes("redis.call('RPUSH', KEYS[1], ARGV[2])")) {
        return Promise.resolve([`${String(args[3])}:1`, 1]);
      }
      if (script.includes("redis.call('LRANGE', KEYS[1], 0, -1)")) {
        return Promise.resolve(
          orphanInputs.map((input) => JSON.stringify(input)),
        );
      }
      return Promise.resolve(1);
    });
    mockQueueAdd.mockClear();
    mockRedisSet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValueOnce('OK');
    mockRedisGet.mockResolvedValue(`${replayChainId}:1`);
    const result = await replayPrReviewNotificationAssociation({
      kind: 'association_replay',
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      chainId: replayChainId,
      attempt: 1,
    });

    expect(result).toEqual({ notifiedTaskCount: 2 });
    expect(mockFindManyTaskPullRequests).toHaveBeenCalledTimes(2);
    expect(
      mockQueueAdd.mock.calls.filter(
        ([name]) => name === 'notify-pr-review-activity',
      ),
    ).toHaveLength(2);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'notify-pr-review-activity',
      expect.objectContaining({ taskId: 'task-1' }),
      { delay: PR_REVIEW_NOTIFICATION_DEBOUNCE_MS },
    );
    const taskEventAppends = multiCalls.filter(
      (call) =>
        call.command === 'rpush' &&
        String(call.args[0]).startsWith('pr-review-notification:pending:'),
    );
    expect(taskEventAppends).toHaveLength(2);
    expect(taskEventAppends.map((call) => String(call.args[1]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('changes_requested'),
        expect.stringContaining('github-review:2'),
      ]),
    );
  });

  it('drains retained orphan activity exactly once after association wake', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
    let replayClaimed = true;
    mockRedisEval.mockImplementation((script: string) => {
      if (script.includes("marker = ARGV[1] .. ':0'")) {
        if (!replayClaimed) {
          return Promise.resolve(null);
        }
        replayClaimed = false;
        return Promise.resolve(`${replayChainId}:0`);
      }
      if (script.includes("redis.call('LRANGE', KEYS[1], 0, -1)")) {
        return Promise.resolve([JSON.stringify(baseInput)]);
      }
      return Promise.resolve(1);
    });

    const request = {
      kind: 'association_replay' as const,
      sourceControlProvider: 'github' as const,
      repository: 'owner/repo',
      prNumber: 42,
      chainId: replayChainId,
      attempt: 1,
    };

    expect(await replayPrReviewNotificationAssociation(request)).toEqual({
      notifiedTaskCount: 1,
    });
    expect(await replayPrReviewNotificationAssociation(request)).toEqual({
      notifiedTaskCount: 0,
      reason: 'stale_association_replay',
    });
    expect(
      mockQueueAdd.mock.calls.filter(
        ([name]) => name === 'notify-pr-review-activity',
      ),
    ).toHaveLength(1);
  });

  it('releases only the expected marker after all five attempts', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(`${replayChainId}:1`);
    mockRedisEval
      .mockResolvedValueOnce(`${replayChainId}:1`)
      .mockResolvedValueOnce(0);

    const result = await replayPrReviewNotificationAssociation({
      kind: 'association_replay',
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      chainId: replayChainId,
      attempt: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length,
    });

    expect(result).toEqual({ notifiedTaskCount: 0, reason: 'no_linked_tasks' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining('release a quiet chain'),
      2,
      'pr-review-notification:orphan:github:owner%2Frepo#42',
      'pr-review-notification:orphan-replay:github:owner%2Frepo#42',
      `${replayChainId}:1`,
      replayChainId,
      expect.any(String),
      900,
    );
  });

  it('releases the initial claim when its replay job cannot be queued', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockQueueAdd.mockRejectedValueOnce(new Error('queue down'));

    await expect(enqueuePrReviewNotification(baseInput)).rejects.toThrow(
      'queue down',
    );

    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      1,
      'pr-review-notification:orphan-replay:github:owner%2Frepo#42',
      expect.any(String),
    );
  });

  it('reclaims an initial enqueue failure after a concurrent append changes the marker', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockQueueAdd
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce(undefined);
    mockRedisEval.mockImplementation((script: string, ...args: unknown[]) => {
      if (script.includes("redis.call('RPUSH', KEYS[1], ARGV[2])")) {
        return Promise.resolve([`${String(args[3])}:1`, 1]);
      }
      if (script.includes("redis.call('LLEN', KEYS[1])")) {
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    });

    await expect(enqueuePrReviewNotification(baseInput)).rejects.toThrow(
      'queue down',
    );

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      'replay-pr-review-association',
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({
        delay: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS[0],
      }),
    );
  });

  it('releases a terminal rotation when its wake job cannot be queued', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(`${replayChainId}:2`);
    mockRedisEval.mockImplementation((script: string) =>
      Promise.resolve(
        script.includes("marker = ARGV[1] .. ':0'") ? `${replayChainId}:2` : 1,
      ),
    );
    mockQueueAdd.mockRejectedValueOnce(new Error('queue down'));

    await expect(
      replayPrReviewNotificationAssociation({
        kind: 'association_replay',
        sourceControlProvider: 'github',
        repository: 'owner/repo',
        prNumber: 42,
        chainId: replayChainId,
        attempt: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length,
      }),
    ).rejects.toThrow('queue down');

    expect(mockRedisEval).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      1,
      'pr-review-notification:orphan-replay:github:owner%2Frepo#42',
      expect.any(String),
    );
  });

  it('releases exhausted-delivery ownership when requeue scheduling fails', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
    mockRedisGet.mockResolvedValue(`${replayChainId}:1`);
    mockRedisEval.mockImplementation((script: string) => {
      if (script.includes("marker = ARGV[1] .. ':0'")) {
        return Promise.resolve(`${replayChainId}:1`);
      }
      if (script.includes("redis.call('LRANGE', KEYS[1], 0, -1)")) {
        return Promise.resolve([JSON.stringify(baseInput)]);
      }
      return Promise.resolve(1);
    });
    mockQueueAdd
      .mockRejectedValueOnce(new Error('delivery queue down'))
      .mockRejectedValueOnce(new Error('replay queue down'));

    await expect(
      replayPrReviewNotificationAssociation({
        kind: 'association_replay',
        sourceControlProvider: 'github',
        repository: 'owner/repo',
        prNumber: 42,
        chainId: replayChainId,
        attempt: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length,
      }),
    ).rejects.toThrow('replay queue down');

    expect(mockRedisEval).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      1,
      'pr-review-notification:orphan-replay:github:owner%2Frepo#42',
      expect.any(String),
    );
  });

  it('lets a failed replay job retry reclaim its retained list', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
    mockRedisEval.mockImplementation((script: string) => {
      if (script.includes("marker = ARGV[1] .. ':0'")) {
        return Promise.resolve(`${replayChainId}:0`);
      }
      if (script.includes("redis.call('LRANGE', KEYS[1], 0, -1)")) {
        return Promise.resolve([JSON.stringify(baseInput)]);
      }
      return Promise.resolve(1);
    });

    const result = await replayPrReviewNotificationAssociation({
      kind: 'association_replay',
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      chainId: replayChainId,
      attempt: 1,
    });

    expect(result).toEqual({ notifiedTaskCount: 1 });
  });

  it('rotates activity appended during the final lookup into one fresh bounded chain', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(`${replayChainId}:1`);
    mockRedisEval
      .mockResolvedValueOnce(`${replayChainId}:1`)
      .mockResolvedValueOnce(1);

    const result = await replayPrReviewNotificationAssociation({
      kind: 'association_replay',
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      chainId: replayChainId,
      attempt: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length,
    });

    expect(result).toEqual({ notifiedTaskCount: 0, reason: 'no_linked_tasks' });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'replay-pr-review-association',
      expect.objectContaining({
        chainId: expect.not.stringMatching(new RegExp(replayChainId)),
        attempt: 1,
      }),
      expect.objectContaining({
        delay: PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS[0],
      }),
    );
  });

  it('debounces ordinary notifications for web-only tasks without an originating conversation', async () => {
    const result = await enqueuePrReviewNotification(baseInput);

    expect(result).toEqual({ notifiedTaskCount: 1 });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'notify-pr-review-activity',
      {
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        deferrals: 0,
        immediate: false,
        batchKind: 'human',
        sourceControlProvider: 'github',
      },
      { delay: PR_REVIEW_NOTIFICATION_DEBOUNCE_MS },
    );
  });

  it('schedules notifications for conversation-linked tasks', async () => {
    const result = await enqueuePrReviewNotification(baseInput);

    expect(result).toEqual({ notifiedTaskCount: 1 });
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('appends ordinary events and schedules a debounced notification job', async () => {
    const result = await enqueuePrReviewNotification(baseInput);

    expect(result).toEqual({ notifiedTaskCount: 1 });

    const rpushCall = multiCalls.find((call) => call.command === 'rpush');
    expect(rpushCall?.args[0]).toContain('task-1');
    expect(rpushCall?.args[1]).toContain('changes_requested');

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'notify-pr-review-activity',
      {
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        deferrals: 0,
        immediate: false,
        batchKind: 'human',
        sourceControlProvider: 'github',
      },
      { delay: PR_REVIEW_NOTIFICATION_DEBOUNCE_MS },
    );
  });

  it('schedules terminal Roomote self-review summaries immediately', async () => {
    const result = await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
      },
    });

    expect(result).toEqual({ notifiedTaskCount: 1 });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'notify-pr-review-activity',
      expect.objectContaining({ immediate: true }),
      { delay: 0 },
    );
  });

  it('debounces Roomote-authored inline review activity', async () => {
    const result = await enqueuePrReviewNotification({
      ...baseInput,
      event: { ...baseInput.event, roomoteAuthored: true },
    });

    expect(result).toEqual({ notifiedTaskCount: 1 });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'notify-pr-review-activity',
      expect.objectContaining({
        immediate: false,
        batchKind: 'roomote',
      }),
      { delay: 15 * 60 * 1000 },
    );
  });

  it('keeps a Roomote cycle in one pending batch and promotes its summary immediately', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        cycleId: 'cycle-1',
        phase: 'open',
        observedAt: 100,
      }),
    );

    await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        reviewHeadSha: 'abc123',
        roomoteAuthored: true,
      },
    });
    await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        reviewHeadSha: 'abc123',
        roomoteAuthored: true,
      },
    });

    const pendingKeys = multiCalls
      .filter((call) => call.command === 'rpush')
      .map((call) => String(call.args[0]));
    const markerKeys = mockRedisSet.mock.calls.map((call) => String(call[0]));

    expect(pendingKeys).toHaveLength(2);
    expect(pendingKeys[0]).toBe(pendingKeys[1]);
    expect(pendingKeys[0]).toContain(':roomote:cycle-1');
    expect(markerKeys).toEqual([
      expect.stringContaining(':delayed'),
      expect.stringContaining(':immediate'),
    ]);
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining('decoded.cycleId ~= ARGV[1]'),
      3,
      expect.stringContaining('review-cycle:'),
      expect.stringContaining('review-cycle-completed'),
      expect.stringContaining('review-cycle-latest-completed'),
      'cycle-1',
      expect.any(Number),
      expect.stringContaining('completed'),
      expect.any(Number),
    );
  });

  it('does not schedule a second job while one is already pending', async () => {
    mockRedisSet.mockResolvedValue(null);

    const result = await enqueuePrReviewNotification(baseInput);

    expect(result).toEqual({ notifiedTaskCount: 1 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(multiCalls.some((call) => call.command === 'rpush')).toBe(true);
  });

  it('releases the scheduled marker when queueing fails', async () => {
    mockQueueAdd.mockRejectedValue(new Error('queue down'));

    await expect(enqueuePrReviewNotification(baseInput)).rejects.toThrow(
      'queue down',
    );
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it('suppresses late Roomote activity for a completed cycle', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        cycleId: 'cycle-1',
        phase: 'completed',
        observedAt: 200,
      }),
    );

    const result = await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        reviewHeadSha: 'abc123',
        roomoteAuthored: true,
      },
    });

    expect(result).toEqual({
      notifiedTaskCount: 0,
      reason: 'review_cycle_completed',
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('keeps newer same-SHA activity in its own batch through enqueue and drain', async () => {
    const completedCycle = JSON.stringify({
      cycleId: 'cycle-1',
      phase: 'completed',
      observedAt: 200,
    });
    mockRedisGet.mockResolvedValue(completedCycle);

    const result = await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        reviewHeadSha: 'abc123',
        batchId: 'github-review:456',
        observedAt: 300,
        roomoteAuthored: true,
      },
    });

    expect(result).toEqual({ notifiedTaskCount: 1 });
    const rpushCall = multiCalls.find((call) => call.command === 'rpush');
    expect(rpushCall?.args[0]).toContain(':roomote:github-review%3A456');

    mockRedisGet.mockImplementation((key: string) =>
      key.includes('review-cycle-completed') ? null : completedCycle,
    );
    mockMultiExec.mockResolvedValue([
      [null, [rpushCall?.args[1]]],
      [null, 1],
    ]);

    await expect(
      consumePendingPrReviewActivity({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        batchKind: 'roomote',
        batchId: 'github-review:456',
      }),
    ).resolves.toEqual([
      {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        reviewHeadSha: 'abc123',
        batchId: 'github-review:456',
        observedAt: 300,
        roomoteAuthored: true,
      },
    ]);
  });

  it('fails open when optional cycle lookup fails for Roomote activity', async () => {
    mockRedisGet.mockRejectedValue(new Error('redis read failed'));

    await expect(
      enqueuePrReviewNotification({
        ...baseInput,
        event: {
          kind: 'review_comment',
          authorLogin: 'roomote[bot]',
          reviewHeadSha: 'abc123',
          roomoteAuthored: true,
        },
      }),
    ).resolves.toEqual({ notifiedTaskCount: 1 });
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('rolls back cycle completion if summary queueing fails', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        cycleId: 'cycle-1',
        phase: 'open',
        observedAt: 100,
      }),
    );
    mockQueueAdd.mockRejectedValue(new Error('queue down'));

    await expect(
      enqueuePrReviewNotification({
        ...baseInput,
        event: {
          kind: 'review_summary',
          authorLogin: 'roomote[bot]',
          reviewHeadSha: 'abc123',
          roomoteAuthored: true,
        },
      }),
    ).rejects.toThrow('queue down');

    expect(mockRedisDel).toHaveBeenCalledWith(
      expect.stringContaining('review-cycle-completed'),
    );
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      expect.stringContaining('review-cycle:'),
      expect.stringContaining('completed'),
      expect.stringContaining('open'),
      expect.any(Number),
    );
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      expect.stringContaining('review-cycle-latest-completed'),
      expect.stringContaining('completed'),
      expect.stringContaining('open'),
      expect.any(Number),
    );
  });

  it('does not let a stale summary complete a newer review cycle', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        cycleId: 'cycle-2',
        phase: 'open',
        observedAt: 300,
      }),
    );

    const result = await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        reviewHeadSha: 'abc123',
        observedAt: 200,
        roomoteAuthored: true,
      },
    });

    expect(result).toEqual({
      notifiedTaskCount: 0,
      reason: 'stale_review_cycle',
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('does not overwrite a review cycle that advances during summary completion', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        cycleId: 'cycle-1',
        phase: 'open',
        observedAt: 100,
      }),
    );
    mockRedisEval.mockResolvedValue(0);

    const result = await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        reviewHeadSha: 'abc123',
        observedAt: 200,
        roomoteAuthored: true,
      },
    });

    expect(result).toEqual({
      notifiedTaskCount: 0,
      reason: 'stale_review_cycle',
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('startPrReviewNotificationCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisEval.mockResolvedValue(1);
  });

  it('records ordered, explicit cycles so the same SHA can be reviewed again', async () => {
    await startPrReviewNotificationCycle({
      repository: 'owner/repo',
      prNumber: 42,
      reviewHeadSha: 'abc123',
      cycleId: 'cycle-1',
      observedAt: 100,
    });
    await startPrReviewNotificationCycle({
      repository: 'owner/repo',
      prNumber: 42,
      reviewHeadSha: 'abc123',
      cycleId: 'cycle-2',
      observedAt: 200,
    });

    expect(mockRedisEval).toHaveBeenLastCalledWith(
      expect.stringContaining('tonumber(decoded.observedAt)'),
      1,
      'pr-review-notification:review-cycle:owner%2Frepo#42:abc123',
      JSON.stringify({
        cycleId: 'cycle-2',
        phase: 'open',
        observedAt: 200,
      }),
      200,
      expect.any(Number),
    );
  });
});

describe('hasPrReviewNotificationThreadContext', () => {
  it('detects Slack thread context from the task binding', () => {
    expect(
      hasPrReviewNotificationThreadContext({
        payload: {},
        slackThreadTs: '1.2',
      } as never),
    ).toBe(true);
  });

  it('detects provider-neutral payload context', () => {
    expect(
      hasPrReviewNotificationThreadContext({
        payload: {
          communicationProvider: 'telegram',
          communicationChannelId: '12345',
        },
        slackThreadTs: null,
      } as never),
    ).toBe(true);
  });

  it('returns false without any conversation context', () => {
    expect(
      hasPrReviewNotificationThreadContext({
        payload: {},
        slackThreadTs: null,
      } as never),
    ).toBe(false);
  });
});

describe('resolvePrReviewNotificationRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves Teams routes from provider-neutral payload fields', async () => {
    const route = await resolvePrReviewNotificationRoute({
      id: 1,
      payload: {
        communicationProvider: 'teams',
        communicationChannelId: '19:abc',
        communicationThreadId: 'thread-1',
        communicationServiceUrl: 'https://smba.example.com',
      },
      taskId: 'task-1',
    } as never);

    expect(route).toEqual({
      provider: 'teams',
      channelId: '19:abc',
      threadId: 'thread-1',
      serviceUrl: 'https://smba.example.com',
    });
    expect(mockResolveSlackTaskRunRouting).not.toHaveBeenCalled();
  });

  it('returns null for Teams payloads without a service URL', async () => {
    const route = await resolvePrReviewNotificationRoute({
      id: 1,
      payload: {
        communicationProvider: 'teams',
        communicationChannelId: '19:abc',
      },
      taskId: 'task-1',
    } as never);

    expect(route).toBeNull();
  });

  it('resolves Telegram routes from provider-neutral payload fields', async () => {
    const route = await resolvePrReviewNotificationRoute({
      id: 1,
      payload: {
        communicationProvider: 'telegram',
        communicationChannelId: '12345',
        communicationThreadId: '77',
      },
      taskId: 'task-1',
    } as never);

    expect(route).toEqual({
      provider: 'telegram',
      channelId: '12345',
      threadId: '77',
    });
  });

  it('resolves Discord routes from provider-neutral payload fields', async () => {
    const route = await resolvePrReviewNotificationRoute({
      id: 1,
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
      },
      taskId: 'task-1',
    } as never);

    expect(route).toEqual({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
  });

  it('resolves Slack routes through the shared Slack routing resolver', async () => {
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: 'C123',
      threadTs: '1.2',
      route: { kind: 'task', webPath: null },
    });

    const route = await resolvePrReviewNotificationRoute({
      id: 1,
      payload: { channel: 'C123' },
      taskId: 'task-1',
    } as never);

    expect(route).toEqual({
      provider: 'slack',
      channelId: 'C123',
      threadId: '1.2',
    });
  });

  it('returns null when no conversation can be resolved', async () => {
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: null,
      threadTs: null,
      route: { kind: 'task', webPath: null },
    });

    const route = await resolvePrReviewNotificationRoute({
      id: 1,
      payload: {},
      taskId: 'task-1',
    } as never);

    expect(route).toBeNull();
  });
});

describe('consumePendingPrReviewActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    multiCalls.length = 0;
    mockRedisDel.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
  });

  it('drains and parses pending events, ignoring malformed entries', async () => {
    mockMultiExec.mockResolvedValue([
      [
        null,
        [
          JSON.stringify({ kind: 'review_comment', authorLogin: 'bob' }),
          'not-json',
          JSON.stringify({ unexpected: true }),
        ],
      ],
      [null, 1],
    ]);

    const events = await consumePendingPrReviewActivity({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
    });

    expect(events).toEqual([{ kind: 'review_comment', authorLogin: 'bob' }]);
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it('drops completed Roomote inline activity while preserving summaries and human feedback', async () => {
    mockRedisGet.mockResolvedValue('summary-notified');
    mockMultiExec.mockResolvedValue([
      [
        null,
        [
          JSON.stringify({
            kind: 'review_comment',
            authorLogin: 'roomote[bot]',
            roomoteAuthored: true,
            reviewHeadSha: 'abc123',
            batchId: 'cycle-1',
          }),
          JSON.stringify({
            kind: 'review_comment',
            authorLogin: 'alice',
            reviewHeadSha: 'abc123',
          }),
          JSON.stringify({
            kind: 'review_summary',
            authorLogin: 'roomote[bot]',
            roomoteAuthored: true,
            reviewHeadSha: 'abc123',
          }),
        ],
      ],
      [null, 1],
    ]);

    const events = await consumePendingPrReviewActivity({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
    });

    expect(mockRedisGet).toHaveBeenCalledWith(
      'pr-review-notification:review-cycle-completed:owner%2Frepo#42:cycle-1',
    );
    expect(events).toEqual([
      {
        kind: 'review_comment',
        authorLogin: 'alice',
        reviewHeadSha: 'abc123',
      },
      {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
        reviewHeadSha: 'abc123',
      },
    ]);
  });

  it('preserves drained events when completion marker lookup fails', async () => {
    const pendingEvents = [
      {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
        reviewHeadSha: 'abc123',
        batchId: 'cycle-1',
      },
      {
        kind: 'review_comment',
        authorLogin: 'alice',
        reviewHeadSha: 'abc123',
      },
    ];
    mockRedisGet.mockRejectedValue(new Error('redis read failed'));
    mockMultiExec.mockResolvedValue([
      [null, pendingEvents.map((event) => JSON.stringify(event))],
      [null, 1],
    ]);

    await expect(
      consumePendingPrReviewActivity({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
      }),
    ).resolves.toEqual(pendingEvents);
  });

  it('suppresses a pre-cycle inline batch after a newer same-SHA cycle starts', async () => {
    const newerSameHeadEvent = {
      kind: 'review_comment',
      authorLogin: 'roomote[bot]',
      roomoteAuthored: true,
      reviewHeadSha: 'abc123',
      batchId: 'github-review:456',
      observedAt: 300,
    } as const;
    mockRedisGet.mockImplementation((key: string) => {
      if (key.includes('review-cycle-completed')) {
        return null;
      }

      return JSON.stringify({
        cycleId: 'github-summary:99:200',
        phase: 'completed',
        observedAt: 200,
      });
    });
    mockMultiExec.mockResolvedValue([
      [
        null,
        [
          JSON.stringify({
            kind: 'review_comment',
            authorLogin: 'roomote[bot]',
            roomoteAuthored: true,
            reviewHeadSha: 'abc123',
            batchId: 'github-review:123',
            observedAt: 100,
          }),
          JSON.stringify(newerSameHeadEvent),
        ],
      ],
      [null, 1],
    ]);

    const events = await consumePendingPrReviewActivity({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      batchKind: 'roomote',
      batchId: 'github-review:123',
    });

    expect(mockRedisGet).toHaveBeenCalledWith(
      'pr-review-notification:review-cycle-latest-completed:owner%2Frepo#42:abc123',
    );
    expect(events).toEqual([newerSameHeadEvent]);
  });
});

describe('formatPrReviewActivityMessage', () => {
  const base = {
    repository: 'owner/repo',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
  };

  it('converts inline markdown links to mrkdwn for Slack', () => {
    const text = formatPrReviewActivityMessage({
      ...base,
      provider: 'slack',
      summary:
        'Alice requested changes on [owner/repo#42](https://github.com/owner/repo/pull/42). Want me to take a look?',
    });

    expect(text).toBe(
      'Alice requested changes on <https://github.com/owner/repo/pull/42|owner/repo#42>. Want me to take a look?',
    );
  });

  it('converts multiple inline markdown links', () => {
    const text = formatPrReviewActivityMessage({
      ...base,
      provider: 'slack',
      summary:
        'I reviewed [owner/repo#42](https://github.com/owner/repo/pull/42) and [flagged two issues](https://github.com/owner/repo/pull/42#issuecomment-1).',
    });

    expect(text).toBe(
      'I reviewed <https://github.com/owner/repo/pull/42|owner/repo#42> and <https://github.com/owner/repo/pull/42#issuecomment-1|flagged two issues>.',
    );
  });

  it('keeps markdown links as-is for Teams', () => {
    const text = formatPrReviewActivityMessage({
      ...base,
      provider: 'teams',
      summary:
        'Alice [left two comments](https://github.com/owner/repo/pull/42#discussion_r1).',
    });

    expect(text).toBe(
      'Alice [left two comments](https://github.com/owner/repo/pull/42#discussion_r1).',
    );
  });

  it('converts markdown links to plain text for Telegram', () => {
    const text = formatPrReviewActivityMessage({
      ...base,
      provider: 'telegram',
      summary:
        'Alice approved [owner/repo#42](https://github.com/owner/repo/pull/42).',
    });

    expect(text).toBe(
      'Alice approved owner/repo#42 (https://github.com/owner/repo/pull/42).',
    );
  });

  it('appends a pull-request link when the summary has no inline link', () => {
    const text = formatPrReviewActivityMessage({
      ...base,
      provider: 'slack',
      summary: 'Alice requested changes and Carol left two comments.',
    });

    expect(text).toBe(
      'Alice requested changes and Carol left two comments.\n' +
        '<https://github.com/owner/repo/pull/42|owner/repo#42>',
    );
  });

  it('trims the summary', () => {
    const text = formatPrReviewActivityMessage({
      ...base,
      provider: 'teams',
      summary:
        '  Bob approved [owner/repo#42](https://github.com/owner/repo/pull/42).  ',
    });

    expect(text).toBe(
      'Bob approved [owner/repo#42](https://github.com/owner/repo/pull/42).',
    );
  });
});
