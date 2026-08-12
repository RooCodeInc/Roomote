const mockFindManyTaskPullRequests = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisEval = vi.fn();
const mockRedisZrangebyscore = vi.fn();
const mockRedisZrem = vi.fn();
const mockQueueAdd = vi.fn();
const mockMultiExec = vi.fn();
const mockResolveSlackTaskRunRouting = vi.fn();
const multiCalls: Array<{ command: string; args: unknown[] }> = [];

function createMultiMock() {
  const multi: Record<string, unknown> = {};

  for (const command of [
    'rpush',
    'expire',
    'lrange',
    'del',
    'set',
    'zadd',
    'zrem',
  ]) {
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
    zrangebyscore: (...args: unknown[]) => mockRedisZrangebyscore(...args),
    zrem: (...args: unknown[]) => mockRedisZrem(...args),
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
  consumePendingPrReviewActivity,
  enqueuePrReviewNotification,
  formatPrReviewActivityMessage,
  hasPrReviewNotificationThreadContext,
  resolvePrReviewNotificationRoute,
  repairPendingPrReviewNotificationJobs,
  startPrReviewNotificationCycle,
  schedulePrReviewNotificationJob,
} from '../pr-review-notification';

describe('enqueuePrReviewNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    multiCalls.length = 0;

    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
    mockRedisEval.mockResolvedValue(1);
    mockRedisZrangebyscore.mockResolvedValue([]);
    mockRedisZrem.mockResolvedValue(1);
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

  it('returns no_linked_tasks when no task links the PR', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);

    const result = await enqueuePrReviewNotification(baseInput);

    expect(result).toEqual({ notifiedTaskCount: 0, reason: 'no_linked_tasks' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
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
    const markerKeys = mockRedisEval.mock.calls
      .filter((call) =>
        String(call[0]).includes("redis.call('ZSCORE', KEYS[2], ARGV[1])"),
      )
      .map((call) => String(call[4]));

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
    mockRedisEval.mockImplementation((script: string) =>
      script.includes("redis.call('ZSCORE', KEYS[2], ARGV[1])") ? 0 : 1,
    );

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

  it('repairs a single pending event after its notification job fails to enqueue', async () => {
    mockQueueAdd
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce(undefined);

    await expect(enqueuePrReviewNotification(baseInput)).rejects.toThrow(
      'queue down',
    );

    const pendingWrites = multiCalls.filter((call) => call.command === 'rpush');
    const recoveryWrite = multiCalls.find(
      (call) =>
        call.command === 'set' && String(call.args[0]).includes('repair'),
    );
    const recoveryMember = multiCalls.find((call) => call.command === 'zadd')
      ?.args[3];

    expect(pendingWrites).toHaveLength(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(recoveryWrite).toBeDefined();
    expect(recoveryMember).toEqual(expect.any(String));

    mockRedisZrangebyscore.mockResolvedValue([recoveryMember]);
    mockRedisGet.mockImplementation((key: string) =>
      key === recoveryWrite?.args[0] ? recoveryWrite.args[1] : null,
    );

    await repairPendingPrReviewNotificationJobs();

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(pendingWrites).toHaveLength(1);
  });

  it('repairs a deferred notification after its replacement job fails to enqueue', async () => {
    mockQueueAdd
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce(undefined);

    const request = {
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      deferrals: 1,
    };

    await expect(
      schedulePrReviewNotificationJob({
        request,
        delayMs: PR_REVIEW_NOTIFICATION_DEBOUNCE_MS,
      }),
    ).rejects.toThrow('queue down');

    const recoveryWrite = multiCalls.find(
      (call) =>
        call.command === 'set' && String(call.args[0]).includes('repair'),
    );
    const recoveryMember = multiCalls.find((call) => call.command === 'zadd')
      ?.args[2];

    expect(recoveryWrite).toBeDefined();
    expect(recoveryMember).toEqual(expect.any(String));

    mockRedisZrangebyscore.mockResolvedValue([recoveryMember]);
    mockRedisGet.mockImplementation((key: string) =>
      key === recoveryWrite?.args[0] ? recoveryWrite.args[1] : null,
    );

    await repairPendingPrReviewNotificationJobs();

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      'notify-pr-review-activity',
      request,
    );
  });

  it('clears repair state when the original job consumes a multi-event batch', async () => {
    let scheduleClaims = 0;
    mockRedisEval.mockImplementation((script: string) => {
      if (script.includes("redis.call('ZSCORE', KEYS[2], ARGV[1])")) {
        scheduleClaims += 1;
        return scheduleClaims === 1 ? 1 : 0;
      }

      return 1;
    });

    await enqueuePrReviewNotification(baseInput);
    await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_comment',
        authorLogin: 'bob',
      },
    });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const repairWrite = multiCalls
      .filter(
        (call) =>
          call.command === 'set' && String(call.args[0]).includes('repair'),
      )
      .at(-1);
    const repairMember = multiCalls
      .filter((call) => call.command === 'zadd')
      .at(-1)?.args[3];
    const dueRepairMembers = new Set([String(repairMember)]);

    mockRedisEval.mockImplementation((script: string) => {
      if (script.includes("redis.call('LRANGE', KEYS[1], 0, -1)")) {
        dueRepairMembers.clear();
        return [
          JSON.stringify(baseInput.event),
          JSON.stringify({ kind: 'review_comment', authorLogin: 'bob' }),
        ];
      }

      if (script.includes("redis.call('ZSCORE', KEYS[2], ARGV[1])")) {
        return dueRepairMembers.size > 0 ? 1 : 0;
      }

      return 1;
    });
    mockRedisZrangebyscore.mockImplementation(() => [...dueRepairMembers]);
    mockRedisGet.mockImplementation((key: string) =>
      key === repairWrite?.args[0] ? repairWrite.args[1] : null,
    );

    await expect(
      consumePendingPrReviewActivity({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        batchKind: 'human',
      }),
    ).resolves.toHaveLength(2);
    await repairPendingPrReviewNotificationJobs();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZREM', KEYS[6], ARGV[1], ARGV[2])"),
      6,
      expect.stringContaining('pr-review-notification:pending:'),
      expect.stringContaining(':delayed'),
      expect.stringContaining(':immediate'),
      expect.stringContaining('repair-payload'),
      expect.stringContaining('repair-payload'),
      'pr-review-notification:repair',
      expect.stringContaining(':delayed'),
      expect.stringContaining(':immediate'),
    );
  });

  it('does not let a stale repair scan enqueue after the batch is consumed', async () => {
    const repairMember = 'task-1:owner%2Frepo#42:human:delayed';
    const request = {
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      deferrals: 0,
      batchKind: 'human' as const,
    };

    mockRedisZrangebyscore.mockResolvedValue([repairMember]);
    mockRedisGet.mockResolvedValue(JSON.stringify(request));
    mockRedisEval.mockImplementation((script: string) =>
      script.includes("redis.call('ZSCORE', KEYS[2], ARGV[1])") ? 0 : 1,
    );

    await repairPendingPrReviewNotificationJobs();

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZSCORE', KEYS[2], ARGV[1])"),
      3,
      expect.stringContaining('pr-review-notification:pending:'),
      'pr-review-notification:repair',
      expect.stringContaining('pr-review-notification:scheduled:'),
      repairMember,
      expect.any(Number),
    );
  });

  it('keeps legacy consume cleanup separate from new human repair state', async () => {
    mockRedisEval.mockResolvedValue([]);

    await consumePendingPrReviewActivity({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
    });

    const consumeCall = mockRedisEval.mock.calls.find((call) =>
      String(call[0]).includes("redis.call('LRANGE', KEYS[1], 0, -1)"),
    );

    expect(consumeCall?.slice(-2)).toEqual([
      'legacy:task-1:owner%2Frepo#42',
      'legacy:task-1:owner%2Frepo#42:immediate',
    ]);
    expect(consumeCall).not.toContain('task-1:owner%2Frepo#42:human:delayed');
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
    mockRedisEval.mockResolvedValue([rpushCall?.args[1]]);

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

  it('keeps cycle completion while a failed summary enqueue awaits repair', async () => {
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

    expect(mockRedisDel).not.toHaveBeenCalledWith(
      expect.stringContaining('review-cycle-completed'),
    );
    expect(mockRedisEval).not.toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
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
    mockRedisEval.mockResolvedValue([]);
  });

  it('drains and parses pending events, ignoring malformed entries', async () => {
    mockRedisEval.mockResolvedValue([
      JSON.stringify({ kind: 'review_comment', authorLogin: 'bob' }),
      'not-json',
      JSON.stringify({ unexpected: true }),
    ]);

    const events = await consumePendingPrReviewActivity({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
    });

    expect(events).toEqual([{ kind: 'review_comment', authorLogin: 'bob' }]);
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('LRANGE', KEYS[1], 0, -1)"),
      6,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'pr-review-notification:repair',
      expect.any(String),
      expect.any(String),
    );
  });

  it('drops completed Roomote inline activity while preserving summaries and human feedback', async () => {
    mockRedisGet.mockResolvedValue('summary-notified');
    mockRedisEval.mockResolvedValue([
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
    mockRedisEval.mockResolvedValue(
      pendingEvents.map((event) => JSON.stringify(event)),
    );

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
    mockRedisEval.mockResolvedValue([
      JSON.stringify({
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
        reviewHeadSha: 'abc123',
        batchId: 'github-review:123',
        observedAt: 100,
      }),
      JSON.stringify(newerSameHeadEvent),
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
