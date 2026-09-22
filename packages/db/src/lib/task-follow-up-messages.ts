import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  isExitedRunStatus,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

import { db } from '../db';
import { taskFollowUpMessages, taskMessages, taskRuns } from '../schema';

const CLAIM_LEASE_MS = 30_000;

export type TaskFollowUpMessage = typeof taskFollowUpMessages.$inferSelect;

export type EnqueueTaskFollowUpMessageInput = {
  runId: number;
  taskId: string;
  userId?: string;
  prompt: string;
  quoteText: string;
  images?: string[];
  source?: string;
  userName?: string;
  userImageUrl?: string;
  workerQuoteUserName?: string;
  clientMessageId?: string;
  deliveryMode: 'send' | 'steer';
};

export type EnqueueTaskFollowUpMessageResult =
  | { accepted: true; inserted: boolean; message: TaskFollowUpMessage }
  | { accepted: false; reason: 'missing_run' | 'settled_run' };

function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getTaskFollowUpMessageClientId(value: string | undefined): string {
  return normalizeOptionalString(value) ?? `task-follow-up:${randomUUID()}`;
}

async function reconcilePersistedTaskFollowUps(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  runId: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE ${taskFollowUpMessages} AS follow_up
    SET
      status = 'delivered',
      delivered_at = COALESCE(follow_up.delivered_at, NOW()),
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = NOW()
    WHERE follow_up.run_id = ${runId}
      AND follow_up.status IN ('pending', 'accepted')
      AND EXISTS (
        SELECT 1
        FROM ${taskMessages} AS message
        WHERE message.run_id = follow_up.run_id
          AND message.task_id = follow_up.task_id
          AND message.protocol = ${ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL}
          AND message.event_type = 'roomote_runtime.user_prompt'
          AND (
            message.metadata ->> 'clientMessageId' = follow_up.client_message_id
            OR message.payload ->> 'clientMessageId' = follow_up.client_message_id
          )
      )
  `);
}

/**
 * Admit a follow-up before attempting live delivery. The run lock keeps a
 * settled task from being reactivated between the caller's status read and
 * this insert. A stable client id makes provider retries idempotent.
 */
export async function enqueueTaskFollowUpMessage(
  input: EnqueueTaskFollowUpMessageInput,
): Promise<EnqueueTaskFollowUpMessageResult> {
  const clientMessageId = getTaskFollowUpMessageClientId(input.clientMessageId);

  return db.transaction(async (tx) => {
    // FOR SHARE blocks a concurrent status/phase update until this admission
    // commits, without conflicting with FK key-share locks from other writers.
    await tx.execute(
      sql`SELECT id FROM ${taskRuns} WHERE id = ${input.runId} FOR SHARE`,
    );
    const run = await tx.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.id, input.runId),
        eq(taskRuns.taskId, input.taskId),
      ),
      columns: {
        status: true,
        canceledAt: true,
        taskPhase: true,
      },
    });

    if (!run) {
      return { accepted: false, reason: 'missing_run' };
    }

    if (
      run.canceledAt ||
      isExitedRunStatus(run.status) ||
      run.taskPhase === 'stopped' ||
      run.taskPhase === 'shutting_down'
    ) {
      return { accepted: false, reason: 'settled_run' };
    }

    const [inserted] = await tx
      .insert(taskFollowUpMessages)
      .values({
        runId: input.runId,
        taskId: input.taskId,
        userId: input.userId,
        prompt: input.prompt,
        quoteText: input.quoteText,
        images: input.images?.length ? input.images : undefined,
        source: normalizeOptionalString(input.source),
        userName: normalizeOptionalString(input.userName),
        userImageUrl: normalizeOptionalString(input.userImageUrl),
        workerQuoteUserName: normalizeOptionalString(input.workerQuoteUserName),
        clientMessageId,
        deliveryMode: input.deliveryMode,
      })
      .onConflictDoNothing({
        target: [
          taskFollowUpMessages.taskId,
          taskFollowUpMessages.clientMessageId,
        ],
      })
      .returning();

    if (inserted) {
      return { accepted: true, inserted: true, message: inserted };
    }

    const existing = await tx.query.taskFollowUpMessages.findFirst({
      where: and(
        eq(taskFollowUpMessages.taskId, input.taskId),
        eq(taskFollowUpMessages.clientMessageId, clientMessageId),
      ),
    });

    if (!existing) {
      throw new Error(
        `Task follow-up ${clientMessageId} was not returned after a duplicate admission`,
      );
    }

    return { accepted: true, inserted: false, message: existing };
  });
}

/**
 * True while a follow-up has not yet been handed to the runtime. Once a row is
 * 'accepted', RuntimePromptQueue owns its ordering, so later messages can use
 * live delivery (including native steering) and still land after it.
 */
export async function hasOpenTaskFollowUpMessages(
  runId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: taskFollowUpMessages.id })
    .from(taskFollowUpMessages)
    .where(
      and(
        eq(taskFollowUpMessages.runId, runId),
        eq(taskFollowUpMessages.status, 'pending'),
      ),
    )
    .limit(1);

  return Boolean(row);
}

/**
 * Activate the sender for one admitted message immediately before its prompt
 * reaches the runtime. Queue admission deliberately does not change the run
 * actor: a later sender must not strand an earlier queued message.
 */
export async function activateTaskFollowUpActor(input: {
  id: string;
  runId: number;
}): Promise<{ userId: string | null } | null> {
  return db.transaction(async (tx) => {
    const message = await tx.query.taskFollowUpMessages.findFirst({
      where: and(
        eq(taskFollowUpMessages.id, input.id),
        eq(taskFollowUpMessages.runId, input.runId),
        inArray(taskFollowUpMessages.status, ['pending', 'accepted']),
      ),
      columns: { userId: true },
    });

    if (!message) {
      return null;
    }

    const run = await tx.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.runId),
      columns: { status: true, canceledAt: true, taskPhase: true },
    });

    if (
      !run ||
      run.canceledAt ||
      isExitedRunStatus(run.status) ||
      run.taskPhase === 'stopped' ||
      run.taskPhase === 'shutting_down'
    ) {
      return null;
    }

    if (!message.userId) {
      return { userId: null };
    }

    await tx.execute(
      sql`SELECT id FROM ${taskRuns} WHERE id = ${input.runId} FOR UPDATE`,
    );
    await tx
      .update(taskRuns)
      .set({ actingUserId: message.userId })
      .where(eq(taskRuns.id, input.runId));

    return { userId: message.userId };
  });
}

/**
 * Claims the oldest pending messages for one worker run. Expired leases are
 * reclaimable after a worker crash. Accepted rows are never reclaimed: the
 * runtime owns them, and a prompt the user deleted from the runtime queue must
 * not be resurrected or block later follow-ups.
 */
export async function claimTaskFollowUpMessages(
  runId: number,
  limit = 20,
): Promise<TaskFollowUpMessage[]> {
  const now = new Date();
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);

  return db.transaction(async (tx) => {
    const run = await tx.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
      columns: {
        taskId: true,
        status: true,
        canceledAt: true,
        taskPhase: true,
      },
    });

    if (!run) {
      return [];
    }

    if (
      run.canceledAt ||
      isExitedRunStatus(run.status) ||
      run.taskPhase === 'stopped' ||
      run.taskPhase === 'shutting_down'
    ) {
      await tx
        .update(taskFollowUpMessages)
        .set({
          status: 'discarded',
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskFollowUpMessages.runId, runId),
            inArray(taskFollowUpMessages.status, ['pending', 'accepted']),
          ),
        );
      return [];
    }

    await reconcilePersistedTaskFollowUps(tx, runId);

    const candidates = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${taskFollowUpMessages}
      WHERE run_id = ${runId}
        AND status = 'pending'
        AND (
          claim_token IS NULL
          OR claim_expires_at IS NULL
          OR claim_expires_at < ${now.toISOString()}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${taskFollowUpMessages} AS earlier
          WHERE earlier.run_id = ${taskFollowUpMessages}.run_id
            AND earlier.sequence < ${taskFollowUpMessages}.sequence
            AND earlier.status = 'pending'
        )
      ORDER BY sequence ASC
      LIMIT ${Math.max(1, Math.min(limit, 100))}
      FOR UPDATE SKIP LOCKED
    `);

    const ids = candidates.map((candidate) => candidate.id);
    if (ids.length === 0) {
      return [];
    }

    const rows = await tx
      .update(taskFollowUpMessages)
      .set({
        claimToken,
        claimExpiresAt,
        attempts: sql`${taskFollowUpMessages.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(taskFollowUpMessages.id, ids))
      .returning();

    return rows.sort((left, right) => left.sequence - right.sequence);
  });
}

export async function markTaskFollowUpAccepted(input: {
  id: string;
  runId: number;
  claimToken: string;
}): Promise<boolean> {
  const [updated] = await db
    .update(taskFollowUpMessages)
    .set({
      status: 'accepted',
      acceptedAt: sql`COALESCE(${taskFollowUpMessages.acceptedAt}, NOW())`,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(taskFollowUpMessages.id, input.id),
        eq(taskFollowUpMessages.runId, input.runId),
        eq(taskFollowUpMessages.claimToken, input.claimToken),
        inArray(taskFollowUpMessages.status, ['pending', 'accepted']),
      ),
    )
    .returning({ id: taskFollowUpMessages.id });

  return Boolean(updated);
}

export async function releaseTaskFollowUpMessage(input: {
  id: string;
  runId: number;
  claimToken: string;
  error?: string;
}): Promise<boolean> {
  const [updated] = await db
    .update(taskFollowUpMessages)
    .set({
      claimToken: null,
      claimExpiresAt: null,
      lastError: input.error?.trim() || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(taskFollowUpMessages.id, input.id),
        eq(taskFollowUpMessages.runId, input.runId),
        eq(taskFollowUpMessages.claimToken, input.claimToken),
        inArray(taskFollowUpMessages.status, ['pending', 'accepted']),
      ),
    )
    .returning({ id: taskFollowUpMessages.id });

  return Boolean(updated);
}

/** Called by runtime transcript persistence as the durable delivery ack. */
export async function markTaskFollowUpDelivered(input: {
  runId: number;
  taskId: string;
  clientMessageId: string;
}): Promise<void> {
  await db
    .update(taskFollowUpMessages)
    .set({
      status: 'delivered',
      deliveredAt: sql`COALESCE(${taskFollowUpMessages.deliveredAt}, NOW())`,
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(taskFollowUpMessages.runId, input.runId),
        eq(taskFollowUpMessages.taskId, input.taskId),
        eq(taskFollowUpMessages.clientMessageId, input.clientMessageId),
        inArray(taskFollowUpMessages.status, ['pending', 'accepted']),
      ),
    );
}
