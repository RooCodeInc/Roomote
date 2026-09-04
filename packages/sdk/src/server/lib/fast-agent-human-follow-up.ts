import {
  acquireFastAgentTurnLock,
  FAST_AGENT_DURABLE_TURN_CLAIM_MS,
  releaseFastAgentDurableTurnClaim,
  type FastAgentTurnLockHandle,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  fastAgentParentEvents,
  isNull,
  ne,
} from '@roomote/db/server';
import type {
  FastAgentHumanFollowUpEvent,
  FastAgentParent,
} from '@roomote/types';

import {
  buildFastAgentParentEventKey,
  enqueueFastAgentParentEvent,
  wakeFastAgentParentEventNow,
} from './fast-agent-parent-event-queue';

export type FastAgentDurableTurn = {
  id: string;
  eventKey: string;
  /**
   * True when admission found this turn's row already pending from an
   * earlier inline attempt that never settled (a re-scheduled web kickoff
   * after a restart, a redelivered webhook). The caller is then resuming
   * that attempt, not starting a fresh one, and must run it as a resumption
   * so the recorded actions are not repeated.
   */
  resumed?: boolean;
};

export type FastAgentHumanFollowUpAdmission =
  | {
      kind: 'turn';
      turnLock: FastAgentTurnLockHandle;
      /** Null when the same message was already settled (duplicate delivery). */
      durable: FastAgentDurableTurn | null;
    }
  | { kind: 'queued'; abort: () => Promise<void> }
  | { kind: 'steered'; abort: () => Promise<void> };

/**
 * Durable admission for a human turn the caller is about to run inline. The
 * row is persisted under a claim lease before any work starts, so the turn
 * survives the accepting process: if that process is interrupted before the
 * turn has posted its closeout, it releases the claim and the parent-event
 * queue resumes the turn, telling it what the earlier attempt already did. The queue is not woken here; a live owner runs
 * the turn itself. An older pending inline row for the same conversation is
 * an interrupted turn this newer message supersedes.
 */
export async function persistFastAgentInlineHumanTurn(params: {
  parent: FastAgentParent;
  event: FastAgentHumanFollowUpEvent;
}): Promise<FastAgentDurableTurn | null> {
  const eventKey = buildFastAgentParentEventKey(params);
  // Admission and supersession commit together, so recovery can never see
  // the new row without the older interrupted row already retired.
  return db.transaction(async (tx) => {
    const claimedUntil = new Date(
      Date.now() + FAST_AGENT_DURABLE_TURN_CLAIM_MS,
    );
    const inserted = await tx
      .insert(fastAgentParentEvents)
      .values({
        conversationId: params.parent.sessionId,
        eventKey,
        parent: params.parent,
        event: params.event,
        admission: 'inline',
        claimedUntil,
      })
      .onConflictDoNothing({ target: fastAgentParentEvents.eventKey })
      .returning({ id: fastAgentParentEvents.id });

    const row = await tx.query.fastAgentParentEvents.findFirst({
      where: eq(fastAgentParentEvents.eventKey, eventKey),
      columns: {
        id: true,
        admission: true,
        deliveredAt: true,
        discardedAt: true,
      },
    });
    if (!row || row.deliveredAt || row.discardedAt) {
      return null;
    }
    // The row was already there and still pending: an earlier inline attempt
    // was interrupted before it settled. This caller takes the row over as a
    // resumption of that attempt, under a fresh claim so the recovery sweep
    // does not hand it to the queue while it runs.
    const resumed = inserted.length === 0 && row.admission === 'inline';
    if (resumed) {
      await tx
        .update(fastAgentParentEvents)
        .set({ claimedUntil, updatedAt: new Date() })
        .where(eq(fastAgentParentEvents.id, row.id));
    }

    await tx
      .update(fastAgentParentEvents)
      .set({
        discardedAt: new Date(),
        lastError: 'Superseded by a newer human message.',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fastAgentParentEvents.conversationId, params.parent.sessionId),
          eq(fastAgentParentEvents.admission, 'inline'),
          ne(fastAgentParentEvents.eventKey, eventKey),
          isNull(fastAgentParentEvents.deliveredAt),
          isNull(fastAgentParentEvents.discardedAt),
        ),
      );

    return { id: row.id, eventKey, ...(resumed ? { resumed: true } : {}) };
  });
}

/**
 * Late durable admission for a turn a shutdown interrupted after its
 * admission write had failed. The turn already ran under this process with
 * its prompt and actions recorded by turn id, so persisting the row now and
 * handing it straight to the queue lets the next process resume it exactly
 * as it would a turn admitted up front. Returns false when no row could be
 * persisted (or the same message already settled), in which case nothing
 * will re-run the turn.
 */
export async function handOffFastAgentInterruptedTurn(params: {
  parent: FastAgentParent;
  event: FastAgentHumanFollowUpEvent;
}): Promise<boolean> {
  const durable = await persistFastAgentInlineHumanTurn(params);
  if (!durable) return false;
  // The row is persisted under this process's claim; this process is going
  // away, so release it at once and ask the queue not to wait for a sweep.
  await releaseFastAgentDurableTurnClaim(durable.id);
  await wakeFastAgentParentEventNow({
    conversationId: params.parent.sessionId,
    eventKey: durable.eventKey,
  }).catch((error) => {
    // The recovery sweep recreates the wakeup within its interval.
    console.warn(
      `[Fast Agent] Late-admitted turn ${durable.id} persisted, but its wakeup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return true;
}

/**
 * Start a human turn immediately when the conversation is idle. While another
 * Fast generation owns the turn lock, durably admit the message for native
 * OpenCode steering instead of waiting to run it as a separate whole turn.
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
    const durable = await persistFastAgentInlineHumanTurn(params).catch(
      (error) => {
        // Admission durability is best effort; the turn still runs inline.
        console.error(
          `[Fast Agent] Failed to persist inline turn admission: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      },
    );
    return { kind: 'turn', turnLock, durable };
  }

  const { eventKey } = await enqueueFastAgentParentEvent({
    parent: params.parent,
    event: params.event,
  });
  return {
    kind: params.forceQueue ? 'queued' : 'steered',
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
