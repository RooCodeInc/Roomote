import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
} from '@roomote/db/server';
import { fastAgentHumanFollowUpEventSchema } from '@roomote/types';

import {
  admitFastAgentHumanFollowUp,
  persistFastAgentInlineHumanTurn,
} from '../fast-agent-human-follow-up';

// Keep queue delivery out of this persistence test; the event itself uses the
// real normalization, transaction and JSONB readback paths.
vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn(async () => ({}));
  },
}));

describe('Discord automated turn durable attribution', () => {
  let sessionId: string;

  beforeEach(async () => {
    const [session] = await db
      .insert(fastAgentConversations)
      .values({
        ownerAutomation: 'slack_channel_auto_start',
        surface: 'discord',
        workspaceId: `guild-${randomUUID()}`,
        conversationId: `thread-${randomUUID()}`,
      })
      .returning({ id: fastAgentConversations.id });
    sessionId = session!.id;
  });

  afterEach(async () => {
    if (sessionId)
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, sessionId));
  });

  it.each(['inline', 'queued'] as const)(
    'preserves automation fields through %s admission and JSONB recovery',
    async (admission) => {
      const parent = {
        sessionId,
        conversation: {
          surface: 'discord' as const,
          workspaceId: 'guild-1',
          conversationId: 'thread-1',
          replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
        },
      };
      const event = {
        type: 'human_follow_up' as const,
        eventId: randomUUID(),
        currentMessageId: 'mention-1',
        userId: 'installer-1',
        question: 'Investigate the alert',
        delegatedTaskInitiator: {
          kind: 'automation' as const,
          key: 'slack_channel_auto_start' as const,
          actor: { externalId: 'feed-1', displayName: 'Feed' },
        },
        delegatedTaskVisibleInTranscript: false,
      };
      if (admission === 'inline')
        await persistFastAgentInlineHumanTurn({ parent, event });
      else
        await admitFastAgentHumanFollowUp({ parent, event, forceQueue: true });

      const row = await db.query.fastAgentParentEvents.findFirst({
        where: eq(fastAgentParentEvents.conversationId, sessionId),
      });
      expect(row?.admission).toBe(admission === 'inline' ? 'inline' : null);
      expect(fastAgentHumanFollowUpEventSchema.parse(row?.event)).toEqual(
        event,
      );
    },
  );
});
