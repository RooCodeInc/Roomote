import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => {
  class DeliveryError extends Error {
    readonly replyPosted: boolean;
    readonly permanent: boolean;

    constructor(
      message: string,
      options: { replyPosted: boolean; permanent?: boolean },
    ) {
      super(message);
      this.replyPosted = options.replyPosted;
      this.permanent = options.permanent ?? false;
    }
  }

  return {
    queueAdd: vi.fn(),
    insertValues: vi.fn(),
    insertOnConflict: vi.fn(),
    transaction: vi.fn(),
    selectForUpdate: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
    findPending: vi.fn(),
    findRun: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: Object.assign(vi.fn(), {
      signal: new AbortController().signal,
    }),
    deliver: vi.fn(),
    retryStartup: vi.fn(),
    recordAutomationOutcome: vi.fn(),
    DeliveryError,
  };
});

vi.mock('bullmq', () => ({
  Queue: class Queue {
    add = mocks.queueAdd;
  },
}));

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    insert: vi.fn(() => ({ values: mocks.insertValues })),
    transaction: mocks.transaction,
    update: vi.fn(() => ({ set: mocks.updateSet })),
    query: {
      fastAgentParentEvents: { findFirst: mocks.findPending },
      taskRuns: { findFirst: mocks.findRun },
    },
  },
  and: vi.fn((...values: unknown[]) => values),
  asc: vi.fn((value: unknown) => value),
  eq: vi.fn((...values: unknown[]) => values),
  isNull: vi.fn((value: unknown) => value),
  lt: vi.fn((...values: unknown[]) => values),
  or: vi.fn((...values: unknown[]) => values),
  recordCustomAutomationRunOutcome: mocks.recordAutomationOutcome,
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  })),
  fastAgentParentEvents: {
    id: 'id',
    conversationId: 'conversation_id',
    eventKey: 'event_key',
    attempts: 'attempts',
    admission: 'admission',
    claimedUntil: 'claimed_until',
    createdAt: 'created_at',
    deliveredAt: 'delivered_at',
    discardedAt: 'discarded_at',
  },
  taskRuns: { id: 'task_runs.id', status: 'task_runs.status' },
}));

vi.mock('./fast-agent-parent-event', () => ({
  buildEventClientMessageSeed: vi.fn(
    (event: { type: string; messageId?: string }) =>
      `${event.type}:${event.messageId ?? 'event'}`,
  ),
  deliverFastAgentParentEventWithLock: mocks.deliver,
  FastAgentParentEventDeliveryError: mocks.DeliveryError,
}));

vi.mock('./task-runs/fast-agent-startup-retry', () => ({
  retryFastAgentStartup: mocks.retryStartup,
}));

import {
  buildFastAgentParentEventKey,
  drainFastAgentParentEvents,
  enqueueFastAgentParentEvent,
  enqueueFastAgentParentEventForRun,
  FastAgentParentBusyError,
} from './fast-agent-parent-event-queue';
import type { FastAgentParentEvent } from './fast-agent-parent-event';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

const event = {
  type: 'child_message' as const,
  taskId: 'child-task',
  runId: 42,
  messageId: 'message-1',
  purpose: 'closeout' as const,
  message: 'Done.',
};

const pullRequestOpenedEvent = {
  type: 'pull_request_opened' as const,
  taskId: 'child-task',
  runId: 42,
  taskUrl: 'https://roomote.example/task/child-task',
  pullRequest: {
    provider: 'github' as const,
    host: 'github.com',
    repository: 'acme/web',
    number: 42,
    title: '[Fix] Keep delivery ordered',
    url: 'https://github.com/acme/web/pull/42',
    status: 'draft' as const,
  },
};

function pendingRow(id: string, queuedEvent: FastAgentParentEvent = event) {
  return {
    id,
    conversationId: parent.sessionId,
    eventKey: `key-${id}`,
    parent,
    event: queuedEvent,
    retryTaskStartRunId: null,
  };
}

describe('Fast parent event durable queue', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.insertValues.mockReturnValue({
      onConflictDoNothing: mocks.insertOnConflict,
    });
    mocks.insertOnConflict.mockResolvedValue(undefined);
    mocks.selectForUpdate.mockResolvedValue([{ status: RunStatus.Running }]);
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn(() => ({ values: mocks.insertValues })),
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({ for: mocks.selectForUpdate })),
              })),
            })),
          })),
        }),
    );
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.queueAdd.mockResolvedValue(undefined);
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.deliver.mockResolvedValue('delivered');
  });

  it('persists before acknowledging and survives an immediate BullMQ failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.queueAdd.mockRejectedValueOnce(new Error('redis restarting'));

    await expect(
      enqueueFastAgentParentEvent({ parent, event }),
    ).resolves.toEqual(expect.objectContaining({ queued: true }));
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ parent, event }),
    );
    expect(mocks.insertOnConflict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.queueAdd.mock.invocationCallOrder[0]!,
    );
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledOnce());
    errorSpy.mockRestore();
  });

  it('acknowledges durable admission without waiting for BullMQ', async () => {
    mocks.queueAdd.mockReturnValueOnce(new Promise(() => {}));

    await expect(
      enqueueFastAgentParentEvent({ parent, event }),
    ).resolves.toEqual(expect.objectContaining({ queued: true }));

    expect(mocks.insertOnConflict).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it('builds a stable BullMQ-safe idempotency key', () => {
    const first = buildFastAgentParentEventKey({ parent, event });
    expect(buildFastAgentParentEventKey({ parent, event })).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('admits each fenced recovery of the same automation occurrence once', () => {
    const automationEvent = {
      type: 'automation_triggered' as const,
      eventId: 'automation-1:2026-09-01T15:11:12.289Z',
      automationId: 'automation-1',
      automationName: 'Nightly scan',
      prompt: 'Find useful work.',
      trigger: 'manual' as const,
    };
    const firstRecovery = buildFastAgentParentEventKey({
      parent,
      event: {
        ...automationEvent,
        launchClaimedAt: '2026-09-01T15:14:52.418Z',
      },
    });
    const retryOfFirstRecovery = buildFastAgentParentEventKey({
      parent,
      event: {
        ...automationEvent,
        launchClaimedAt: '2026-09-01T15:14:52.418Z',
      },
    });
    const secondRecovery = buildFastAgentParentEventKey({
      parent,
      event: {
        ...automationEvent,
        launchClaimedAt: '2026-09-01T15:24:00.000Z',
      },
    });

    expect(retryOfFirstRecovery).toBe(firstRecovery);
    expect(secondRecovery).not.toBe(firstRecovery);
  });

  it('releases a Fast automation launch claim only after delivery settles', async () => {
    const eventClaimedAt = new Date('2026-09-01T15:11:12.289Z');
    const launchClaimedAt = new Date('2026-09-01T15:14:52.418Z');
    const automationEvent = {
      type: 'automation_triggered' as const,
      eventId: `automation-1:${eventClaimedAt.toISOString()}`,
      automationId: 'automation-1',
      automationName: 'Nightly scan',
      launchClaimedAt: launchClaimedAt.toISOString(),
      prompt: 'Find useful work.',
      trigger: 'manual' as const,
    };
    const row = pendingRow('automation-event', automationEvent);
    mocks.findPending
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(undefined);

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: row.eventKey,
    });

    expect(mocks.recordAutomationOutcome).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'automation-1',
        launchClaimedAt,
        status: 'succeeded',
      },
    );
  });

  it('records a permanent Fast automation delivery failure', async () => {
    const launchClaimedAt = new Date('2026-09-01T14:25:14.129Z');
    const automationEvent = {
      type: 'automation_triggered' as const,
      eventId: `automation-1:${launchClaimedAt.toISOString()}`,
      automationId: 'automation-1',
      automationName: 'Nightly scan',
      launchClaimedAt: launchClaimedAt.toISOString(),
      prompt: 'Find useful work.',
      trigger: 'manual' as const,
    };
    const row = pendingRow('automation-event', automationEvent);
    mocks.findPending
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(undefined);
    mocks.deliver.mockRejectedValueOnce(
      new mocks.DeliveryError('parent session missing', {
        replyPosted: false,
        permanent: true,
      }),
    );

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: row.eventKey,
    });

    expect(mocks.recordAutomationOutcome).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'automation-1',
        launchClaimedAt,
        status: 'failed',
        error: 'parent session missing',
      },
    );
  });

  it('records success when delivery fails after a reply was posted', async () => {
    const launchClaimedAt = new Date('2026-09-01T15:18:41.782Z');
    const automationEvent = {
      type: 'automation_triggered' as const,
      eventId: `automation-1:${launchClaimedAt.toISOString()}`,
      automationId: 'automation-1',
      automationName: 'Nightly scan',
      launchClaimedAt: launchClaimedAt.toISOString(),
      prompt: 'Find useful work.',
      trigger: 'manual' as const,
    };
    const row = pendingRow('automation-replied', automationEvent);
    mocks.findPending
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(undefined);
    mocks.deliver.mockRejectedValueOnce(
      new mocks.DeliveryError('transcript persistence failed', {
        replyPosted: true,
      }),
    );

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: row.eventKey,
    });

    expect(mocks.recordAutomationOutcome).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'automation-1',
        launchClaimedAt,
        status: 'succeeded',
      },
    );
  });

  it('uses the stable event key as the sole durable admission claim', async () => {
    const eventKey = buildFastAgentParentEventKey({ parent, event });

    await enqueueFastAgentParentEvent({ parent, event });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventKey }),
    );
    expect(mocks.insertOnConflict).toHaveBeenCalledWith({
      target: 'event_key',
    });
  });

  it('locks the run row before admitting a PR-open event', async () => {
    const result = await enqueueFastAgentParentEventForRun({
      parent,
      event: pullRequestOpenedEvent,
      runId: pullRequestOpenedEvent.runId,
    });

    expect(result).toEqual(expect.objectContaining({ queued: true }));
    expect(mocks.selectForUpdate).toHaveBeenCalledWith('update');
    expect(mocks.insertOnConflict).toHaveBeenCalledWith({
      target: 'event_key',
    });
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it.each([RunStatus.Completed, RunStatus.Failed, RunStatus.Canceled])(
    'skips PR-open admission after %s settlement',
    async (status) => {
      mocks.selectForUpdate.mockResolvedValueOnce([{ status }]);

      const result = await enqueueFastAgentParentEventForRun({
        parent,
        event: pullRequestOpenedEvent,
        runId: pullRequestOpenedEvent.runId,
      });

      expect(result).toEqual(expect.objectContaining({ queued: false }));
      expect(mocks.insertValues).not.toHaveBeenCalled();
      expect(mocks.queueAdd).not.toHaveBeenCalled();
    },
  );

  it('still admits PR-open while the run is idle', async () => {
    mocks.selectForUpdate.mockResolvedValueOnce([{ status: RunStatus.Idle }]);

    await expect(
      enqueueFastAgentParentEventForRun({
        parent,
        event: pullRequestOpenedEvent,
        runId: pullRequestOpenedEvent.runId,
      }),
    ).resolves.toEqual(expect.objectContaining({ queued: true }));
  });

  it('drains one parent in durable creation order under one turn lock', async () => {
    const first = pendingRow('event-1', { ...event, messageId: 'message-1' });
    const second = pendingRow('event-2', { ...event, messageId: 'message-2' });
    mocks.findPending
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(undefined);

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: first.eventKey,
    });

    expect(mocks.acquireLock).toHaveBeenCalledOnce();
    expect(mocks.deliver).toHaveBeenCalledTimes(2);
    expect(mocks.deliver.mock.calls[0]?.[0]?.event.messageId).toBe('message-1');
    expect(mocks.deliver.mock.calls[1]?.[0]?.event.messageId).toBe('message-2');
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it.each(['merged', 'closed'] as const)(
    'keeps a newer %s pull request event ahead of a stale child closeout idempotently',
    async (status) => {
      const terminalEvent: FastAgentParentEvent = {
        type: 'pull_request_status_changed',
        taskId: event.taskId,
        runId: event.runId,
        taskUrl: 'https://roomote.test/task/child-task',
        pullRequest: {
          provider: 'github',
          host: null,
          repository: 'RooCodeInc/Roomote',
          number: 1887,
          title: 'Release Roomote 1.0.0',
          url: 'https://github.com/RooCodeInc/Roomote/pull/1887',
          status,
        },
        status,
        actorLogin: 'maintainer',
      };
      const staleCloseout: FastAgentParentEvent = {
        ...event,
        messageId: `stale-after-${status}`,
        message: 'The pull request remains draft and unpublished.',
      };
      const terminalRow = pendingRow(`pr-${status}`, terminalEvent);
      const staleRow = pendingRow(`stale-${status}`, staleCloseout);
      mocks.findPending
        .mockResolvedValueOnce(terminalRow)
        .mockResolvedValueOnce(terminalRow)
        .mockResolvedValueOnce(staleRow)
        .mockResolvedValueOnce(undefined);

      await drainFastAgentParentEvents({
        conversationId: parent.sessionId,
        eventKey: staleRow.eventKey,
      });
      await drainFastAgentParentEvents({
        conversationId: parent.sessionId,
        eventKey: staleRow.eventKey,
      });

      expect(mocks.deliver).toHaveBeenCalledTimes(2);
      expect(mocks.deliver.mock.calls.map(([params]) => params.event)).toEqual([
        terminalEvent,
        staleCloseout,
      ]);
    },
  );

  it('re-runs an interrupted inline-admitted human turn as a resumption', async () => {
    const inlineRow = {
      ...pendingRow('inline-1', {
        type: 'human_follow_up' as const,
        eventId: '100.2',
        currentMessageId: '100.2',
        userId: 'user-1',
        question: 'What broke?',
      }),
      admission: 'inline' as const,
      claimedUntil: null,
    };
    mocks.findPending
      .mockResolvedValueOnce(inlineRow)
      .mockResolvedValueOnce(inlineRow)
      // The resumed run settled its own row.
      .mockResolvedValueOnce({ deliveredAt: new Date(), discardedAt: null })
      .mockResolvedValueOnce(undefined);
    mocks.acquireLock.mockResolvedValueOnce(mocks.releaseLock);
    mocks.deliver.mockResolvedValueOnce('delivered');

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: inlineRow.eventKey,
    });

    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        event: inlineRow.event,
        resumedAfterInterruption: true,
        durableAdmission: { eventId: 'inline-1' },
      }),
      mocks.releaseLock,
    );
    expect(
      mocks.updateSet.mock.calls.some(
        ([value]) =>
          value && typeof value === 'object' && 'deliveredAt' in value,
      ),
    ).toBe(true);
  });

  it('leaves a resumed inline turn pending when the run deferred itself', async () => {
    const inlineRow = {
      ...pendingRow('inline-2', {
        type: 'human_follow_up' as const,
        eventId: '100.3',
        currentMessageId: '100.3',
        userId: 'user-1',
        question: 'Still there?',
      }),
      admission: 'inline' as const,
      claimedUntil: null,
    };
    mocks.findPending
      .mockResolvedValueOnce(inlineRow)
      .mockResolvedValueOnce(inlineRow)
      // The run released its claim without settling: its terminal
      // revocation did not land, so recovery still owns the outcome.
      .mockResolvedValueOnce({ deliveredAt: null, discardedAt: null });
    mocks.acquireLock.mockResolvedValueOnce(mocks.releaseLock);
    mocks.deliver.mockResolvedValueOnce('delivered');

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: inlineRow.eventKey,
    });

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    // Not settled here and not re-run in a loop; the sweep retries later.
    expect(
      mocks.updateSet.mock.calls.some(
        ([value]) =>
          value && typeof value === 'object' && 'deliveredAt' in value,
      ),
    ).toBe(false);
    expect(mocks.releaseLock).toHaveBeenCalled();
  });

  it('returns a retryable busy signal without occupying a worker slot', async () => {
    const first = pendingRow('event-1');
    mocks.findPending.mockResolvedValueOnce(first);
    mocks.acquireLock.mockResolvedValueOnce(null);

    await expect(
      drainFastAgentParentEvents({
        conversationId: parent.sessionId,
        eventKey: first.eventKey,
      }),
    ).rejects.toBeInstanceOf(FastAgentParentBusyError);
    expect(mocks.acquireLock).toHaveBeenCalledWith({
      conversation: parent.conversation,
      maxWaitMs: 0,
    });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('admits a PR-open event before retrying delivery for a busy parent', async () => {
    const pullRequestOpened = {
      type: 'pull_request_opened' as const,
      taskId: 'child-task',
      runId: 42,
      taskUrl: 'https://roomote.example/task/child-task',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: '[Fix] Keep delivery asynchronous',
        url: 'https://github.com/acme/web/pull/42',
        status: 'draft' as const,
      },
    };
    const row = pendingRow('pr-opened', pullRequestOpened);
    mocks.findPending.mockResolvedValueOnce(row);
    mocks.acquireLock.mockResolvedValueOnce(null);

    await expect(
      enqueueFastAgentParentEvent({ parent, event: pullRequestOpened }),
    ).resolves.toEqual(expect.objectContaining({ queued: true }));
    await expect(
      drainFastAgentParentEvents({
        conversationId: parent.sessionId,
        eventKey: row.eventKey,
      }),
    ).rejects.toBeInstanceOf(FastAgentParentBusyError);

    expect(mocks.insertOnConflict).toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('delivers PR-open before a later task-settled event', async () => {
    const pullRequestOpened = {
      type: 'pull_request_opened' as const,
      taskId: 'child-task',
      runId: 42,
      taskUrl: 'https://roomote.example/task/child-task',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: '[Fix] Keep delivery ordered',
        url: 'https://github.com/acme/web/pull/42',
        status: 'draft' as const,
      },
    };
    const taskSettled = {
      type: 'task_settled' as const,
      taskId: 'child-task',
      runId: 42,
      status: 'idle' as const,
      taskUrl: 'https://roomote.example/task/child-task',
      pullRequests: [pullRequestOpened.pullRequest],
    };
    const first = pendingRow('pr-opened', pullRequestOpened);
    const second = pendingRow('task-settled', taskSettled);
    mocks.findPending
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(undefined);

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: first.eventKey,
    });

    expect(
      mocks.deliver.mock.calls.map(([params]) => params.event.type),
    ).toEqual(['pull_request_opened', 'task_settled']);
  });

  it('delivers a durable human follow-up after response finalization releases the lock', async () => {
    const humanFollowUp = {
      type: 'human_follow_up' as const,
      eventId: '100.003',
      currentMessageId: '100.003',
      userId: 'user-2',
      question: 'Use the corrected requirement.',
    };
    const row = pendingRow('human-follow-up', humanFollowUp);
    mocks.findPending
      // The first wakeup overlaps the response finalization window.
      .mockResolvedValueOnce(row)
      // The retry acquires the released lock and drains the same durable row.
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(undefined);
    mocks.acquireLock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mocks.releaseLock);

    const request = {
      conversationId: parent.sessionId,
      eventKey: row.eventKey,
    };
    await expect(drainFastAgentParentEvents(request)).rejects.toBeInstanceOf(
      FastAgentParentBusyError,
    );
    await drainFastAgentParentEvents(request);

    expect(mocks.deliver).toHaveBeenCalledOnce();
    expect(mocks.deliver).toHaveBeenCalledWith(
      { parent, event: humanFollowUp },
      mocks.releaseLock,
    );
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('keeps later events pending when the head has a transient failure', async () => {
    const first = pendingRow('event-1');
    const second = pendingRow('event-2', { ...event, messageId: 'message-2' });
    mocks.findPending
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    mocks.deliver.mockRejectedValueOnce(new Error('provider offline'));

    await expect(
      drainFastAgentParentEvents({
        conversationId: parent.sessionId,
        eventKey: first.eventKey,
      }),
    ).rejects.toThrow('provider offline');
    expect(mocks.deliver).toHaveBeenCalledOnce();
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('discards a permanent head failure and continues to the next event', async () => {
    const first = pendingRow('event-1');
    const second = pendingRow('event-2', { ...event, messageId: 'message-2' });
    mocks.findPending
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(undefined);
    mocks.deliver
      .mockRejectedValueOnce(
        new mocks.DeliveryError('parent gone', {
          replyPosted: false,
          permanent: true,
        }),
      )
      .mockResolvedValueOnce('delivered');

    await drainFastAgentParentEvents({
      conversationId: parent.sessionId,
      eventKey: first.eventKey,
    });
    expect(mocks.deliver).toHaveBeenCalledTimes(2);
  });
});
