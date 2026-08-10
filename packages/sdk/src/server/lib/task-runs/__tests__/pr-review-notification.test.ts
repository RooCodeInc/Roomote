const mockFindManyTaskPullRequests = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn();
const mockQueueAdd = vi.fn();
const mockMultiExec = vi.fn();
const mockResolveSlackTaskRunRouting = vi.fn();
const multiCalls: Array<{ command: string; args: unknown[] }> = [];

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
} from '../pr-review-notification';

describe('enqueuePrReviewNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    multiCalls.length = 0;

    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
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
      expect.objectContaining({ immediate: false }),
      { delay: PR_REVIEW_NOTIFICATION_DEBOUNCE_MS },
    );
  });

  it('keeps immediate self-review activity separate from ordinary activity', async () => {
    await enqueuePrReviewNotification(baseInput);
    await enqueuePrReviewNotification({
      ...baseInput,
      event: {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
      },
    });

    const pendingKeys = multiCalls
      .filter((call) => call.command === 'rpush')
      .map((call) => String(call.args[0]));
    const markerKeys = mockRedisSet.mock.calls.map((call) => String(call[0]));

    expect(pendingKeys).toEqual([
      expect.not.stringContaining(':immediate'),
      expect.stringContaining(':immediate'),
    ]);
    expect(markerKeys).toEqual([
      expect.not.stringContaining(':immediate'),
      expect.stringContaining(':immediate'),
    ]);
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
      'pr-review-notification:review-completed:owner%2Frepo#42:abc123',
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
