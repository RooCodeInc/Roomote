const mockPersistPrReviewEvent = vi.fn();
const mockRecordPrReviewCycleState = vi.fn();
const mockClaimDuePrReviewDeliveries = vi.fn();
const mockReleasePrReviewDeliveries = vi.fn();
const mockDeferPrReviewDeliveries = vi.fn();
const mockCompletePrReviewDeliveries = vi.fn();
const mockRenewPrReviewDeliveryClaim = vi.fn();
const mockRedisLrange = vi.fn();
const mockRedisGet = vi.fn();
const mockQueueAdd = vi.fn();
const mockResolveSlackTaskRunRouting = vi.fn();
const mockFindManySlackInstallations = vi.fn();

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      query: {
        slackInstallations: {
          findMany: (...args: unknown[]) =>
            mockFindManySlackInstallations(...args),
        },
      },
    },
    persistPrReviewEvent: (...args: unknown[]) =>
      mockPersistPrReviewEvent(...args),
    recordPrReviewCycleState: (...args: unknown[]) =>
      mockRecordPrReviewCycleState(...args),
    claimDuePrReviewDeliveries: (...args: unknown[]) =>
      mockClaimDuePrReviewDeliveries(...args),
    releasePrReviewDeliveries: (...args: unknown[]) =>
      mockReleasePrReviewDeliveries(...args),
    deferPrReviewDeliveries: (...args: unknown[]) =>
      mockDeferPrReviewDeliveries(...args),
    completePrReviewDeliveries: (...args: unknown[]) =>
      mockCompletePrReviewDeliveries(...args),
    renewPrReviewDeliveryClaim: (...args: unknown[]) =>
      mockRenewPrReviewDeliveryClaim(...args),
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: (...args: unknown[]) => mockRedisGet(...args),
    lrange: (...args: unknown[]) => mockRedisLrange(...args),
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
  dispatchDuePrReviewNotifications,
  enqueuePrReviewNotification,
  formatPrReviewActivityMessage,
  hasPrReviewNotificationThreadContext,
  migrateLegacyPrReviewNotificationRequest,
  resolvePrReviewNotificationRoute,
  schedulePrReviewNotificationJob,
  startPrReviewNotificationCycle,
} from '../pr-review-notification';

const baseInput = {
  repository: 'owner/repo',
  prNumber: 42,
  prUrl: 'https://github.com/owner/repo/pull/42',
  event: {
    kind: 'review' as const,
    providerEventId: 'github-review:123',
    authorLogin: 'alice',
    reviewState: 'changes_requested',
    observedAt: 100,
  },
};

const claim = {
  deliveryIds: ['delivery-1'],
  leaseToken: '00000000-0000-4000-8000-000000000001',
  taskId: 'task-1',
  sourceControlProvider: 'github',
  repository: 'owner/repo',
  prNumber: 42,
  prUrl: 'https://github.com/owner/repo/pull/42',
  batchKind: 'human',
  batchId: null,
  deferrals: 0,
  events: [baseInput.event],
};

it('defers rate-limited deliveries without consuming task deferral budget', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));

  await schedulePrReviewNotificationJob({
    request: {
      taskId: claim.taskId,
      repository: claim.repository,
      prNumber: claim.prNumber,
      prUrl: claim.prUrl,
      deferrals: 0,
      deliveryIds: claim.deliveryIds,
      leaseToken: claim.leaseToken,
      events: [],
    },
    delayMs: 900_000,
    countDeferral: false,
  });

  expect(mockDeferPrReviewDeliveries).toHaveBeenCalledWith(
    { deliveryIds: claim.deliveryIds, leaseToken: claim.leaseToken },
    new Date('2026-08-22T12:15:00.000Z'),
    { incrementDeferrals: false },
  );
  vi.useRealTimers();
});

describe('durable PR review notification ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    mockPersistPrReviewEvent.mockResolvedValue({ projectedTaskCount: 1 });
    mockRecordPrReviewCycleState.mockResolvedValue(undefined);
    mockClaimDuePrReviewDeliveries.mockResolvedValue([]);
    mockReleasePrReviewDeliveries.mockResolvedValue(undefined);
    mockRedisLrange.mockResolvedValue([]);
    mockFindManySlackInstallations.mockResolvedValue([{ teamId: 'T123' }]);
    mockRedisGet.mockResolvedValue(null);
    mockQueueAdd.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits the normalized event without creating Redis ownership state', async () => {
    await expect(enqueuePrReviewNotification(baseInput)).resolves.toEqual({
      notifiedTaskCount: 1,
    });

    expect(mockPersistPrReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'owner/repo',
        prNumber: 42,
        dueAt: new Date(1_000 + PR_REVIEW_NOTIFICATION_DEBOUNCE_MS),
      }),
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('groups one external automated reviewer under a stable database batch', async () => {
    const automatedAuthorId = 'github:9001';
    for (const [index, kind] of [
      'issue_comment',
      'review',
      'review_comment',
    ].entries()) {
      await enqueuePrReviewNotification({
        ...baseInput,
        event: {
          kind: kind as 'issue_comment' | 'review' | 'review_comment',
          providerEventId: `github-automated:${index}`,
          authorLogin: 'reviewer[bot]',
          automatedAuthorId,
          observedAt: 100 + index,
        },
      });
    }

    expect(mockPersistPrReviewEvent).toHaveBeenCalledTimes(3);
    for (const [input] of mockPersistPrReviewEvent.mock.calls) {
      expect(input).toMatchObject({
        batchKind: 'human',
        batchId: `automated:${automatedAuthorId}`,
        automatedAuthorId,
        dueAt: new Date(1_000 + PR_REVIEW_NOTIFICATION_DEBOUNCE_MS),
      });
    }
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('propagates persistence failure to the webhook caller', async () => {
    mockPersistPrReviewEvent.mockRejectedValue(new Error('database down'));

    await expect(enqueuePrReviewNotification(baseInput)).rejects.toThrow(
      'database down',
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('keeps committed work pending when the BullMQ wake fails', async () => {
    mockClaimDuePrReviewDeliveries.mockResolvedValue([claim]);
    mockQueueAdd.mockRejectedValue(new Error('queue down'));

    await expect(dispatchDuePrReviewNotifications()).resolves.toBe(0);
    expect(mockReleasePrReviewDeliveries).toHaveBeenCalledWith(claim);
  });

  it('records an explicit Roomote review cycle in Postgres', async () => {
    await startPrReviewNotificationCycle({
      repository: 'owner/repo',
      prNumber: 42,
      reviewHeadSha: 'abc123',
      cycleId: 'cycle-1',
      observedAt: 200,
    });

    expect(mockRecordPrReviewCycleState).toHaveBeenCalledWith({
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      reviewHeadSha: 'abc123',
      cycleId: 'cycle-1',
      phase: 'open',
      observedAt: new Date(200),
    });
  });

  it('reads legacy Redis state without mutating it and materializes the cycle first', async () => {
    const inline = {
      kind: 'review_comment' as const,
      authorLogin: 'roomote[bot]',
      roomoteAuthored: true,
      reviewHeadSha: 'abc123',
      batchId: 'old-inline-batch',
      observedAt: 100,
    };
    mockRedisLrange.mockResolvedValue([JSON.stringify(inline)]);
    mockRedisGet.mockImplementation((key: string) =>
      key.includes('review-cycle:')
        ? JSON.stringify({
            cycleId: 'summary-cycle',
            phase: 'completed',
            observedAt: 200,
          })
        : null,
    );

    await expect(
      migrateLegacyPrReviewNotificationRequest({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        deferrals: 0,
        batchKind: 'roomote',
        batchId: 'old-inline-batch',
      }),
    ).resolves.toBe(1);

    expect(mockRecordPrReviewCycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleId: 'summary-cycle',
        phase: 'completed',
      }),
    );
    expect(
      mockRecordPrReviewCycleState.mock.invocationCallOrder[0],
    ).toBeLessThan(mockPersistPrReviewEvent.mock.invocationCallOrder[0]!);
    expect(mockPersistPrReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: inline }),
    );
  });

  it('consumes only events carried by an active database lease', async () => {
    await expect(
      consumePendingPrReviewActivity({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        deliveryIds: claim.deliveryIds,
        leaseToken: claim.leaseToken,
        events: claim.events,
      }),
    ).resolves.toEqual(claim.events);

    await expect(
      consumePendingPrReviewActivity({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
      }),
    ).rejects.toThrow('without a lease');
  });
});

describe('PR review notification routing', () => {
  it('detects Slack and provider-neutral conversation context', () => {
    expect(
      hasPrReviewNotificationThreadContext({
        payload: {},
        slackThreadTs: '1.2',
      }),
    ).toBe(true);
    expect(
      hasPrReviewNotificationThreadContext({
        payload: {
          communicationProvider: 'telegram',
          communicationChannelId: '12345',
        },
        slackThreadTs: null,
      }),
    ).toBe(true);
  });

  it('resolves Teams from provider-neutral fields', async () => {
    await expect(
      resolvePrReviewNotificationRoute({
        id: 1,
        taskId: 'task-1',
        payload: {
          communicationProvider: 'teams',
          communicationChannelId: '19:abc',
          communicationThreadId: 'thread-1',
          communicationServiceUrl: 'https://smba.example.com',
        },
      } as never),
    ).resolves.toEqual({
      provider: 'teams',
      channelId: '19:abc',
      threadId: 'thread-1',
      serviceUrl: 'https://smba.example.com',
    });
  });

  it('resolves Slack through the shared resolver', async () => {
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: 'C123',
      teamId: 'T123',
      threadTs: '1.2',
    });
    await expect(
      resolvePrReviewNotificationRoute({
        id: 1,
        taskId: 'task-1',
        payload: {},
      } as never),
    ).resolves.toEqual({
      provider: 'slack',
      slackTeamId: 'T123',
      channelId: 'C123',
      threadId: '1.2',
    });
  });

  it('returns null when no conversation can be resolved', async () => {
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: null,
      teamId: null,
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

  it('fails closed for legacy Slack routing when multiple workspaces are active', async () => {
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: 'C123',
      teamId: null,
      threadTs: '1.2',
      route: { kind: 'task', webPath: null },
    });
    mockFindManySlackInstallations.mockResolvedValue([
      { teamId: 'T123' },
      { teamId: 'T456' },
    ]);

    await expect(
      resolvePrReviewNotificationRoute({
        id: 1,
        payload: { channel: 'C123' },
        taskId: 'task-1',
      } as never),
    ).resolves.toBeNull();
  });
});

describe('formatPrReviewActivityMessage', () => {
  it('converts markdown links for Slack and appends a missing PR link', () => {
    expect(
      formatPrReviewActivityMessage({
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        provider: 'slack',
        summary:
          'Alice commented on [the review](https://github.com/owner/repo/pull/42#discussion_r1).',
      }),
    ).toBe(
      'Alice commented on <https://github.com/owner/repo/pull/42#discussion_r1|the review>.',
    );
    expect(
      formatPrReviewActivityMessage({
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        provider: 'slack',
        summary: 'Alice requested changes.',
      }),
    ).toBe(
      'Alice requested changes.\n<https://github.com/owner/repo/pull/42|owner/repo#42>',
    );
  });
});
