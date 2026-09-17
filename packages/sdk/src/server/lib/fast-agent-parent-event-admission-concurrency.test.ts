const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  acquireLock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class Queue {
    add = mocks.queueAdd;
  },
}));

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));

// The Redis turn lock is not what these cases exercise, so it is replaced by
// a deterministic in-process mutex with the same contract: one holder per
// conversation, and a refusal (null) while another holder owns the turn.
vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  acquireFastAgentTurnLock: mocks.acquireLock,
}));

import {
  db,
  eq,
  fastAgentMessages,
  fastAgentParentEvents,
  userFactory,
  users,
} from '@roomote/db/server';
import {
  isFastAgentCanonicalEventSuperseded,
  loadFastAgentCanonicalMessages,
  projectFastAgentCanonicalEvents,
  renderFastAgentCanonicalHistory,
  type FastAgentTurnLockHandle,
} from '@roomote/cloud-agents/server';
import { getOrCreateFastAgentSession } from '@roomote/cloud-agents/server';
import type { FastAgentHumanFollowUpEvent } from '@roomote/types';

import { deliverFastAgentParentEventWithLock } from './fast-agent-parent-event';
import {
  drainFastAgentParentEvents,
  enqueueFastAgentParentEvent,
} from './fast-agent-parent-event-queue';

vi.mock('./fast-agent-parent-event', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./fast-agent-parent-event')>();
  return { ...actual, deliverFastAgentParentEventWithLock: vi.fn() };
});

type ConsumedTurn = {
  eventId: string;
  suppressed: boolean;
  /** Rendered history the turn would have sent to the model. */
  context: string;
};

describe('Fast parent event admission concurrent with consumption', () => {
  let userId: string;
  let sessionId: string;
  const conversation = {
    surface: 'web' as const,
    workspaceId: 'admission-concurrency-workspace',
    conversationId: 'admission-concurrency-conversation',
  };
  const parent = () => ({ sessionId, conversation });

  /** Turns the drain actually ran, in consumption order. */
  let consumed: ConsumedTurn[];
  /** Resolves when the held turn has snapshotted its projection. */
  let heldTurnReachedBoundary: Promise<void>;
  /** Releases the held turn so it may finish. */
  let releaseHeldTurn: () => void;
  /** Event id whose turn pauses at the projection boundary. */
  let holdEventId: string | null;

  beforeEach(async () => {
    mocks.queueAdd.mockResolvedValue(undefined);
    consumed = [];
    holdEventId = null;
    let signalBoundary!: () => void;
    heldTurnReachedBoundary = new Promise<void>((resolve) => {
      signalBoundary = resolve;
    });
    let resolveRelease!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    releaseHeldTurn = resolveRelease;

    let lockHeld = false;
    mocks.acquireLock.mockImplementation(async () => {
      if (lockHeld) return null;
      lockHeld = true;
      const release = (async () => {
        lockHeld = false;
      }) as FastAgentTurnLockHandle;
      release.signal = new AbortController().signal;
      return release;
    });

    const user = await userFactory.create();
    userId = user.id;
    const session = await getOrCreateFastAgentSession({ userId, conversation });
    sessionId = session.id;

    // Stands in for a consuming turn: it snapshots the canonical projection
    // exactly once, before any model request, which is the real
    // linearization boundary in `answerFastAgentQuestion`.
    vi.mocked(deliverFastAgentParentEventWithLock).mockImplementation(
      async ({ event }) => {
        const eventId = (event as FastAgentHumanFollowUpEvent).currentMessageId;
        const canonicalEventId = `${eventId}:user`;
        const projection = projectFastAgentCanonicalEvents(
          await loadFastAgentCanonicalMessages(sessionId),
        );
        const suppressed = isFastAgentCanonicalEventSuperseded(
          projection,
          canonicalEventId,
        );
        if (eventId === holdEventId) {
          signalBoundary();
          await released;
        }
        consumed.push({
          eventId,
          suppressed,
          context: JSON.stringify(
            renderFastAgentCanonicalHistory(projection, {
              excludeEventId: canonicalEventId,
            }),
          ),
        });
        return suppressed ? 'skipped' : 'delivered';
      },
    );
  });

  afterEach(async () => {
    releaseHeldTurn();
    await db.delete(users).where(eq(users.id, userId));
  });

  function setupState(
    id: string,
    source: 'yellow' | 'green',
    version: number,
  ): FastAgentHumanFollowUpEvent {
    const setupSnapshot = JSON.stringify({ rail: { source } });
    return {
      type: 'human_follow_up',
      eventId: id,
      currentMessageId: id,
      userId,
      question: `<platform_event>${JSON.stringify({
        type: 'setup_state_changed',
        snapshot: JSON.parse(setupSnapshot),
        version,
      })}</platform_event>`,
      turnSource: 'platform_event',
      platformEventKind: 'setup',
      platformEventVisibility: 'required',
      setupSession: true,
      setupContext: {
        sessionId,
        fastConversationId: sessionId,
        setupSnapshot,
        starterTaskOptions: [],
      },
    };
  }

  async function admit(event: FastAgentHumanFollowUpEvent) {
    return enqueueFastAgentParentEvent({ parent: parent(), event });
  }

  async function drain(eventKey: string) {
    return drainFastAgentParentEvents({ conversationId: sessionId, eventKey });
  }

  it('suppresses a queued state a newer admission replaced and leaves the newest authoritative', async () => {
    // yellow v10 -> green v11 queued -> yellow v12, all durably admitted
    // before the drain runs, which is the reported contradiction.
    const yellowV10 = await admit(setupState('yellow-v10', 'yellow', 10));
    await admit(setupState('green-v11', 'green', 11));
    await admit(setupState('yellow-v12', 'yellow', 12));

    await drain(yellowV10.eventKey);

    expect(
      consumed.map(({ eventId, suppressed }) => [eventId, suppressed]),
    ).toEqual([
      ['yellow-v10', true],
      ['green-v11', true],
      ['yellow-v12', false],
    ]);
    // The surviving turn carries no superseded state into its context: both
    // the stale green claim and the older yellow are dropped, so the only
    // state fact in play is the event being consumed.
    const finalContext = consumed.at(-1)!.context;
    expect(finalContext).not.toContain('green');
    expect(finalContext).not.toContain('yellow-v10');

    const rows = await db.query.fastAgentMessages.findMany({
      where: eq(fastAgentMessages.conversationId, sessionId),
    });
    expect(
      rows
        .map(({ conversationSeq }) => conversationSeq)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([1, 2, 3]);
    const projection = projectFastAgentCanonicalEvents(rows);
    expect(projection.currentStateEventIds).toEqual(['yellow-v12:user']);
  });

  it('does not let an in-flight turn see an event admitted after its projection boundary', async () => {
    const green = await admit(setupState('green-v11', 'green', 11));
    holdEventId = 'green-v11';

    const draining = drain(green.eventKey);
    await heldTurnReachedBoundary;

    // Admitted while the green turn is mid-flight, after it snapshotted.
    await admit(setupState('yellow-v12', 'yellow', 12));
    releaseHeldTurn();
    await draining;

    const greenTurn = consumed.find(({ eventId }) => eventId === 'green-v11')!;
    // Honest boundary: the in-flight turn ran on pre-admission state. It is
    // not retroactively suppressed, and it never saw the newer event.
    expect(greenTurn.suppressed).toBe(false);
    expect(greenTurn.context).not.toContain('yellow-v12');

    // The newer event is still admitted durably and consumed afterwards with
    // the green state demoted, so the conversation ends on the truth.
    const yellowTurn = consumed.find(({ eventId }) => eventId === 'yellow-v12');
    expect(yellowTurn?.suppressed).toBe(false);
    const projection = projectFastAgentCanonicalEvents(
      await loadFastAgentCanonicalMessages(sessionId),
    );
    expect(projection.currentStateEventIds).toEqual(['yellow-v12:user']);
  });

  it('admits each event once and never re-delivers a settled turn', async () => {
    const green = await admit(setupState('green-v11', 'green', 11));
    // A provider retry of the same occurrence.
    const duplicate = await admit(setupState('green-v11', 'green', 11));
    expect(duplicate.eventKey).toBe(green.eventKey);

    await drain(green.eventKey);
    // A repeat wakeup for an already drained inbox.
    await drain(green.eventKey);

    expect(consumed.map(({ eventId }) => eventId)).toEqual(['green-v11']);
    const [parentRows, canonicalRows] = await Promise.all([
      db.query.fastAgentParentEvents.findMany({
        where: eq(fastAgentParentEvents.conversationId, sessionId),
      }),
      db.query.fastAgentMessages.findMany({
        where: eq(fastAgentMessages.conversationId, sessionId),
      }),
    ]);
    expect(parentRows).toHaveLength(1);
    expect(parentRows[0]?.deliveredAt).toBeInstanceOf(Date);
    expect(canonicalRows).toHaveLength(1);
  });

  it('refuses to consume while another turn owns the conversation', async () => {
    const green = await admit(setupState('green-v11', 'green', 11));
    const owner = await mocks.acquireLock();
    expect(owner).not.toBeNull();

    await expect(drain(green.eventKey)).rejects.toThrow(/busy/iu);
    expect(consumed).toEqual([]);

    await owner!();
    await drain(green.eventKey);
    expect(consumed.map(({ eventId }) => eventId)).toEqual(['green-v11']);
  });

  it('rebuilds the same authoritative state from the canonical log after a cold restart', async () => {
    const yellowV10 = await admit(setupState('yellow-v10', 'yellow', 10));
    await admit(setupState('green-v11', 'green', 11));
    await admit(setupState('yellow-v12', 'yellow', 12));
    await drain(yellowV10.eventKey);
    const warmContext = consumed.at(-1)!.context;

    // A cold consumer keeps nothing in memory and replays the durable log.
    const coldProjection = projectFastAgentCanonicalEvents(
      await loadFastAgentCanonicalMessages(sessionId),
    );
    const coldContext = JSON.stringify(
      renderFastAgentCanonicalHistory(coldProjection, {
        excludeEventId: 'yellow-v12:user',
      }),
    );

    expect(coldContext).toEqual(warmContext);
    expect(coldProjection.currentStateEventIds).toEqual(['yellow-v12:user']);
  });
});
