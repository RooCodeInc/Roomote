import {
  asc,
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  userFactory,
} from '@roomote/db/server';
import { fastAgentHumanFollowUpEventSchema } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  acquireLock: vi.fn(),
  queueAdd: vi.fn(),
  findSession: vi.fn(),
  delivery: vi.fn(),
}));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  FAST_AGENT_DURABLE_TURN_CLAIM_MS: 15 * 60 * 1000,
  findFastAgentDurableRetryScheduledError: () => null,
}));
// BullMQ belongs to the SDK, not the web package; mock its resolved dependency.
vi.mock('../../../../../../packages/sdk/node_modules/bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd;
  },
}));
vi.mock('@roomote/redis', () => ({ getRedis: () => ({}) }));
vi.mock(
  '../../../../../../packages/sdk/src/server/lib/fast-agent-parent-event',
  () => ({
    buildEventClientMessageSeed: (event: { eventId: string }) => event.eventId,
    FastAgentParentEventDeliveryError: class extends Error {},
  }),
);
vi.mock(
  '../../../../../../packages/sdk/src/server/lib/task-runs/fast-agent-startup-retry',
  () => ({ retryFastAgentStartup: vi.fn() }),
);
vi.mock('@roomote/sdk/server', async () => {
  const admission =
    await import('../../../../../../packages/sdk/src/server/lib/fast-agent-human-follow-up');
  return {
    admitFastAgentHumanFollowUp: admission.admitFastAgentHumanFollowUp,
    buildFastAgentSurfaceReplyDelivery: mocks.delivery,
  };
});
vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mocks.findSession,
  buildFastSessionPrReviewDestinationKey: (session: { id: string }) =>
    session.id,
  updateFastSessionPrReviewOfferStatus: vi.fn(),
}));
vi.mock('@/lib/server/pr-review-actions', () => ({}));
vi.mock('@/lib/server/artifact-signature', () => ({}));
vi.mock('./pinned-launch', () => ({}));
vi.mock('./composer-suggestion', () => ({}));

import { replyToFastSessionCommand } from './index';

it.each(['idle', 'busy'])(
  'persists %s composer replies and wakes the shared queue before success without running after',
  async (state) => {
    vi.clearAllMocks();
    const user = await userFactory.create();
    const conversation = {
      surface: 'web' as const,
      workspaceId: user.id,
      conversationId: `composer-${user.id}`,
    };
    const [session] = await db
      .insert(fastAgentConversations)
      .values({ userId: user.id, ...conversation })
      .returning();
    mocks.findSession.mockResolvedValue(session);
    mocks.delivery.mockResolvedValue({ conversation, adapter: {} });
    mocks.acquireLock.mockResolvedValue(state === 'idle' ? vi.fn() : null);
    mocks.queueAdd.mockResolvedValue(undefined);
    const auth = {
      userId: user.id,
      name: user.name,
      primaryEmail: 'composer@example.com',
      isAdmin: false,
    } as UserAuthSuccess;
    try {
      for (const text of ['First clarification', 'Second clarification']) {
        await expect(
          replyToFastSessionCommand(auth, {
            sessionId: session!.id,
            text,
            attachmentTexts: ['Attached document'],
            images: ['image'],
            model: 'openrouter/z-ai/glm-5.2',
            reasoningEffort: 'high',
          }),
        ).resolves.toEqual({ success: true });
        const persisted = await db.query.fastAgentParentEvents.findMany({
          where: eq(fastAgentParentEvents.conversationId, session!.id),
          orderBy: [
            asc(fastAgentParentEvents.createdAt),
            asc(fastAgentParentEvents.id),
          ],
        });
        expect(persisted.at(-1)?.event).toMatchObject({
          question: text,
          userId: user.id,
          attachmentTexts: ['Attached document'],
          images: ['image'],
        });
        expect(mocks.queueAdd).toHaveBeenLastCalledWith(
          'deliver',
          { conversationId: session!.id, eventKey: persisted.at(-1)!.eventKey },
          { jobId: persisted.at(-1)!.eventKey },
        );
        const stored = await db.query.fastAgentConversations.findFirst({
          where: eq(fastAgentConversations.id, session!.id),
        });
        expect(stored).toMatchObject({
          model: 'openrouter/z-ai/glm-5.2',
          reasoningEffort: 'high',
        });
      }
      const rows = await db.query.fastAgentParentEvents.findMany({
        where: eq(fastAgentParentEvents.conversationId, session!.id),
        orderBy: [
          asc(fastAgentParentEvents.createdAt),
          asc(fastAgentParentEvents.id),
        ],
      });
      const events = rows.map((row) =>
        fastAgentHumanFollowUpEventSchema.parse(row.event),
      );
      expect(events.map((event) => event.question)).toEqual([
        'First clarification',
        'Second clarification',
      ]);
      expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
      for (const event of events) {
        expect(event.currentMessageId).toBe(event.eventId);
        expect(event.attachmentTexts).toEqual(['Attached document']);
      }
      expect(
        rows.every(
          (row) => !row.admission && !row.deliveredAt && !row.discardedAt,
        ),
      ).toBe(true);
      expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
      expect(mocks.acquireLock).not.toHaveBeenCalled();
      expect(mocks.after).not.toHaveBeenCalled();
    } finally {
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, session!.id));
    }
  },
);
