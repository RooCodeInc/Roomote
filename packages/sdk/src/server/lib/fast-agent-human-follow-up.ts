import {
  acquireFastAgentTurnLock,
  FAST_AGENT_DURABLE_TURN_CLAIM_MS,
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

/**
 * Outcome of durably admitting an inline human turn. `settled` means the same
 * message already ran to completion (delivered) or was retired (superseded,
 * replay revoked): the caller must not run it again.
 */
export type FastAgentInlineHumanTurnAdmission =
  | { status: 'admitted'; turn: FastAgentDurableTurn }
  | { status: 'settled' };

export type FastAgentHumanFollowUpAdmission =
  | {
      kind: 'turn';
      turnLock: FastAgentTurnLockHandle;
      /**
       * Null when durable admission could not be persisted (the turn still
       * runs, best effort) or when the same message was already settled; the
       * latter is flagged by `settled` so the caller skips the turn.
       */
      durable: FastAgentDurableTurn | null;
      settled?: boolean;
    }
  | { kind: 'queued'; abort: () => Promise<void> }
  | { kind: 'steered'; abort: () => Promise<void> };

/**
 * Durable admission for a human turn the caller is about to run inline. The
 * row is persisted under a claim lease before any work starts, so the turn
 * survives the accepting process: if that process is interrupted before the
 * turn has posted its closeout, it releases the claim and the parent-event
 * queue resumes the turn, telling it what the earlier attempt already did.
 * The queue is not woken here; a live owner runs the turn itself.
 *
 * A typed human message supersedes an older pending inline row for the same
 * conversation: that row is an interrupted or parked turn, and the new turn
 * is told about the request it still owes. A reaction or a platform event
 * admitted through this path does not supersede anything: neither answers
 * the earlier request, so the earlier turn keeps its row and resumes once
 * the conversation is idle again.
 */
/**
 * Only a typed human message stands in for the request an older pending turn
 * still owes. A reaction (`input`) or a platform event admitted through the
 * human path (`turnSource`) is a side conversation: discarding the older row
 * for it would silently drop a question that was parked for a retry or
 * waiting to resume.
 */
function supersedesPendingTurns(event: FastAgentHumanFollowUpEvent): boolean {
  return !event.input && event.turnSource !== 'platform_event';
}

export async function persistFastAgentInlineHumanTurn(params: {
  parent: FastAgentParent;
  event: FastAgentHumanFollowUpEvent;
}): Promise<FastAgentDurableTurn | null> {
  const admission = await admitFastAgentInlineHumanTurn(params);
  return admission.status === 'admitted' ? admission.turn : null;
}

/**
 * Like `persistFastAgentInlineHumanTurn`, but distinguishes "already settled"
 * from a fresh admission. Callers with a second durable trigger for the same
 * message (the AgentMail inbound drain) need that distinction: an interrupted
 * turn the queue already resumed and delivered must be skipped, not re-run.
 */
export async function admitFastAgentInlineHumanTurn(params: {
  parent: FastAgentParent;
  event: FastAgentHumanFollowUpEvent;
}): Promise<FastAgentInlineHumanTurnAdmission> {
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
    if (!row) {
      throw new Error(
        `Fast inline turn admission row ${eventKey} vanished mid-transaction.`,
      );
    }
    if (row.deliveredAt || row.discardedAt) {
      return { status: 'settled' as const };
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

    // A Slack aside may be ignored; it cannot replace an unfinished request.
    if (
      supersedesPendingTurns(params.event) &&
      !(
        params.parent.conversation.surface === 'slack' &&
        params.event.directedAtRoomote === false
      )
    ) {
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
    }

    return {
      status: 'admitted' as const,
      turn: { id: row.id, eventKey, ...(resumed ? { resumed: true } : {}) },
    };
  });
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
    const admission = await admitFastAgentInlineHumanTurn(params).catch(
      (error) => {
        // Admission durability is best effort; the turn still runs inline.
        console.error(
          `[Fast Agent] Failed to persist inline turn admission: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      },
    );
    if (admission?.status === 'settled') {
      return { kind: 'turn', turnLock, durable: null, settled: true };
    }
    return { kind: 'turn', turnLock, durable: admission?.turn ?? null };
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
