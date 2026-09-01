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
    createdAt: 'created_at',
    deliveredAt: 'delivered_at',
    discardedAt: 'discarded_at',
  },
  taskRuns: { id: 'task_runs.id' },
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
    errorSpy.mockRestore();
  });

  it('builds a stable BullMQ-safe idempotency key', () => {
    const first = buildFastAgentParentEventKey({ parent, event });
    expect(buildFastAgentParentEventKey({ parent, event })).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('releases a Fast automation launch claim only after delivery settles', async () => {
    const launchClaimedAt = new Date('2026-09-01T15:11:12.289Z');
    const automationEvent = {
      type: 'automation_triggered' as const,
      eventId: `automation-1:${launchClaimedAt.toISOString()}`,
      automationId: 'automation-1',
      automationName: 'Nightly scan',
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
