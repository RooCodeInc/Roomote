import {
  acquireFastAgentTurnLock,
  type FastAgentTurnLockHandle,
} from '@roomote/cloud-agents/server';
import { and, db, eq, fastAgentParentEvents, isNull } from '@roomote/db/server';
import type {
  FastAgentHumanFollowUpEvent,
  FastAgentParent,
} from '@roomote/types';

import { enqueueFastAgentParentEvent } from './fast-agent-parent-event-queue';

export type FastAgentHumanFollowUpAdmission =
  | { kind: 'turn'; turnLock: FastAgentTurnLockHandle }
  | { kind: 'queued'; abort: () => Promise<void> };

/**
 * Start a human turn immediately when the conversation is idle. While another
 * Fast generation owns the turn lock, durably admit the message so the parent
 * event queue runs it as a subsequent serialized turn.
 */
export async function admitFastAgentHumanFollowUp(params: {
  parent: FastAgentParent;
  event: FastAgentHumanFollowUpEvent;
  forceQueue?: boolean;
}): Promise<FastAgentHumanFollowUpAdmission> {
  const turnLock = params.forceQueue
    ? null
    : await acquireFastAgentTurnLock({
        conversation: params.parent.conversation,
        maxWaitMs: 0,
      });
  if (turnLock) {
    return { kind: 'turn', turnLock };
  }

  const { eventKey } = await enqueueFastAgentParentEvent({
    parent: params.parent,
    event: params.event,
  });
  return {
    kind: 'queued',
    abort: async () => {
      await db
        .update(fastAgentParentEvents)
        .set({
          discardedAt: new Date(),
          lastError: 'Fast human follow-up admission was withdrawn.',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(fastAgentParentEvents.eventKey, eventKey),
            isNull(fastAgentParentEvents.deliveredAt),
            isNull(fastAgentParentEvents.discardedAt),
          ),
        );
    },
  };
}
