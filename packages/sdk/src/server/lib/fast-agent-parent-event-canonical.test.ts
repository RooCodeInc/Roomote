const mocks = vi.hoisted(() => ({ queueAdd: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class Queue {
    add = mocks.queueAdd;
  },
}));

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));

import {
  db,
  eq,
  fastAgentMessages,
  fastAgentParentEvents,
  userFactory,
  users,
} from '@roomote/db/server';
import {
  FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY,
  type FastAgentHumanFollowUpEvent,
} from '@roomote/types';
import {
  getOrCreateFastAgentSession,
  projectFastAgentCanonicalEvents,
  upsertFastAgentMessage,
} from '@roomote/cloud-agents/server';

import { enqueueFastAgentParentEvent } from './fast-agent-parent-event-queue';

describe('Fast parent event canonical admission', () => {
  let userId: string;
  let sessionId: string;
  const conversation = {
    surface: 'web' as const,
    workspaceId: 'canonical-admission-workspace',
    conversationId: 'canonical-admission-conversation',
  };

  beforeEach(async () => {
    mocks.queueAdd.mockResolvedValue(undefined);
    const user = await userFactory.create();
    userId = user.id;
    const session = await getOrCreateFastAgentSession({
      userId,
      conversation,
    });
    sessionId = session.id;
  });

  afterEach(async () => {
    await db.delete(users).where(eq(users.id, userId));
  });

  function setupEvent(
    id: string,
    source: 'yellow' | 'green',
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

  it('atomically records hidden input once and allocates concurrent admission order', async () => {
    const parent = { sessionId, conversation };
    const green = setupEvent('green-event', 'green');
    const yellow = setupEvent('yellow-event', 'yellow');

    await Promise.all([
      enqueueFastAgentParentEvent({ parent, event: green }),
      enqueueFastAgentParentEvent({ parent, event: yellow }),
      enqueueFastAgentParentEvent({ parent, event: green }),
    ]);

    const [parentRows, canonicalRows] = await Promise.all([
      db.query.fastAgentParentEvents.findMany({
        where: eq(fastAgentParentEvents.conversationId, sessionId),
      }),
      db.query.fastAgentMessages.findMany({
        where: eq(fastAgentMessages.conversationId, sessionId),
      }),
    ]);
    expect(parentRows).toHaveLength(2);
    expect(canonicalRows).toHaveLength(2);
    expect(
      canonicalRows
        .map(({ conversationSeq }) => conversationSeq)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([1, 2]);
    expect(
      canonicalRows.every(
        ({ metadata, observedAt }) =>
          metadata?.visibleInTranscript === false &&
          Boolean(metadata?.[FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY]) &&
          observedAt instanceof Date,
      ),
    ).toBe(true);
    expect(
      projectFastAgentCanonicalEvents(canonicalRows).currentStateEventIds,
    ).toHaveLength(1);
  });

  it('preserves admission provenance when consumption idempotently upserts the prompt', async () => {
    const parent = { sessionId, conversation };
    await enqueueFastAgentParentEvent({
      parent,
      event: {
        type: 'child_message',
        taskId: 'task-1',
        runId: 42,
        messageId: 'child-message-1',
        purpose: 'progress',
        message: 'The source is ready.',
      },
    });
    const [admitted] = await db.query.fastAgentMessages.findMany({
      where: eq(fastAgentMessages.conversationId, sessionId),
    });
    await upsertFastAgentMessage({
      sessionId,
      message: {
        eventId: admitted!.eventId,
        turnId: admitted!.turnId,
        turnSeq: 0,
        ts: Date.now(),
        eventType: admitted!.eventType,
        role: 'user',
        contentBlocks: admitted!.contentBlocks,
        metadata: {
          visibleInTranscript: false,
          turnSource: 'platform_event',
          [FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY]: {
            schemaVersion: 1,
            kind: 'historical_observation',
            authority: 'roomote_runtime',
            observedAt: new Date().toISOString(),
            sourceEventId: 'replacement',
          },
        },
        payload: {},
        source: 'web',
      },
    });
    const updated = await db.query.fastAgentMessages.findFirst({
      where: eq(fastAgentMessages.id, admitted!.id),
    });
    expect(
      updated?.metadata?.[FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY],
    ).toMatchObject({
      authority: 'delegated_task',
      sourceEventId: 'fast-parent-child-message:child-message-1',
    });
    expect(updated?.conversationSeq).toBe(admitted?.conversationSeq);
    expect(updated?.observedAt).toEqual(admitted?.observedAt);
  });
});
