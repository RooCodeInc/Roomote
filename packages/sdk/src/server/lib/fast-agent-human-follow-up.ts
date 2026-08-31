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
  | { kind: 'steered'; abort: () => Promise<void> };

/**
 * Start a human turn immediately when the conversation is idle. While another
 * Fast generation owns the turn lock, durably admit the message for native
 * OpenCode steering instead of waiting to run it as a separate whole turn.
 */
export async function admitFastAgentHumanFollowUp(params: {
  parent: FastAgentParent;
  event: FastAgentHumanFollowUpEvent;
}): Promise<FastAgentHumanFollowUpAdmission> {
  const turnLock = await acquireFastAgentTurnLock({
    conversation: params.parent.conversation,
    maxWaitMs: 0,
  });
  if (turnLock) {
    return { kind: 'turn', turnLock };
  }

  const { eventKey } = await enqueueFastAgentParentEvent(params);
  return {
    kind: 'steered',
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
