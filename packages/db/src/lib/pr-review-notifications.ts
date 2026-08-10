import { and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';

import {
  isTaskExecutingTurn,
  WORKER_HEARTBEAT_STALE_MS,
  type SourceControlProvider,
} from '@roomote/types';

import { db } from '../db';
import {
  prReviewAggregateEvents,
  prReviewAggregates,
  prReviewEvents,
  prReviewFixClaims,
  prReviewNotificationDeliveries,
  taskPullRequests,
  taskRuns,
  type PrReviewEventKind,
  type PrReviewNotificationDeliveryState,
} from '../schema';

export const PR_REVIEW_ASSOCIATION_REPLAY_MS = 15 * 60 * 1000;
export const PR_REVIEW_DELIVERY_MAX_ATTEMPTS = 5;
export const PR_REVIEW_DELIVERY_RETRY_DELAYS_MS = [
  0,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const;
export const PR_REVIEW_DELIVERY_ALERT_AFTER_MS = 15 * 60 * 1000;

export type PersistPrReviewEventInput = {
  sourceControlProvider: SourceControlProvider;
  eventKey: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  reviewHeadSha?: string;
  kind: PrReviewEventKind;
  authorLogin: string;
  roomoteAuthored?: boolean;
  payload: Record<string, unknown>;
  receivedAt?: Date;
};

async function fanOutEventToTask(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    event: typeof prReviewEvents.$inferSelect;
    taskId: string;
  },
): Promise<string> {
  const headSha = input.event.reviewHeadSha || 'unknown';
  const [insertedAggregate] = await tx
    .insert(prReviewAggregates)
    .values({
      taskId: input.taskId,
      sourceControlProvider: input.event.sourceControlProvider,
      repository: input.event.repository,
      prNumber: input.event.prNumber,
      prUrl: input.event.prUrl,
      reviewHeadSha: headSha,
      version: 0,
      events: [],
      latestEventAt: input.event.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: prReviewAggregates.id });

  const aggregate =
    insertedAggregate ??
    (await tx.query.prReviewAggregates.findFirst({
      where: and(
        eq(prReviewAggregates.taskId, input.taskId),
        eq(
          prReviewAggregates.sourceControlProvider,
          input.event.sourceControlProvider,
        ),
        eq(prReviewAggregates.repository, input.event.repository),
        eq(prReviewAggregates.prNumber, input.event.prNumber),
        eq(prReviewAggregates.reviewHeadSha, headSha),
      ),
      columns: { id: true },
    }));

  if (!aggregate) {
    throw new Error('Failed to resolve PR review aggregate after insert.');
  }

  const [membership] = await tx
    .insert(prReviewAggregateEvents)
    .values({ aggregateId: aggregate.id, eventId: input.event.id })
    .onConflictDoNothing()
    .returning({ id: prReviewAggregateEvents.id });

  if (membership) {
    const payload = JSON.stringify(input.event.payload);
    await tx
      .update(prReviewAggregates)
      .set({
        version: sql`${prReviewAggregates.version} + 1`,
        events: sql`coalesce(${prReviewAggregates.events}, '[]'::jsonb) || jsonb_build_array(${payload}::jsonb)`,
        latestEventAt: input.event.receivedAt,
        updatedAt: new Date(),
      })
      .where(eq(prReviewAggregates.id, aggregate.id));
  }

  await tx
    .insert(prReviewNotificationDeliveries)
    .values([
      { aggregateId: aggregate.id, destination: 'task_history' },
      { aggregateId: aggregate.id, destination: 'chat' },
    ])
    .onConflictDoNothing();

  if (membership) {
    await tx
      .update(prReviewNotificationDeliveries)
      .set({
        state: 'waiting_for_idle',
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
        deliveredAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(prReviewNotificationDeliveries.aggregateId, aggregate.id),
          sql`${prReviewNotificationDeliveries.state} <> 'unknown'`,
        ),
      );
  }

  return aggregate.id;
}

export async function persistPrReviewEventAndFanOut(
  input: PersistPrReviewEventInput,
): Promise<{ eventId: string; aggregateIds: string[]; taskIds: string[] }> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(prReviewEvents)
      .values({
        sourceControlProvider: input.sourceControlProvider,
        eventKey: input.eventKey,
        repository: input.repository,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        reviewHeadSha: input.reviewHeadSha ?? 'unknown',
        kind: input.kind,
        authorLogin: input.authorLogin,
        roomoteAuthored: input.roomoteAuthored ?? false,
        payload: input.payload,
        ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
      })
      .onConflictDoNothing()
      .returning();

    const event =
      inserted ??
      (await tx.query.prReviewEvents.findFirst({
        where: and(
          eq(prReviewEvents.sourceControlProvider, input.sourceControlProvider),
          eq(prReviewEvents.eventKey, input.eventKey),
        ),
      }));

    if (!event) {
      throw new Error('Failed to persist PR review event.');
    }

    const links = await tx.query.taskPullRequests.findMany({
      where: and(
        eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
        eq(taskPullRequests.repository, input.repository),
        eq(taskPullRequests.prNumber, input.prNumber),
      ),
      columns: { taskId: true },
    });
    const taskIds = [...new Set(links.map((link) => link.taskId))];
    const aggregateIds: string[] = [];

    for (const taskId of taskIds) {
      aggregateIds.push(await fanOutEventToTask(tx, { event, taskId }));
    }

    return { eventId: event.id, aggregateIds, taskIds };
  });
}

export async function replayRecentPrReviewEventsForAssociation(input: {
  taskId: string;
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  linkedAt?: Date;
}): Promise<string[]> {
  const linkedAt = input.linkedAt ?? new Date();
  const since = new Date(linkedAt.getTime() - PR_REVIEW_ASSOCIATION_REPLAY_MS);

  return db.transaction(async (tx) => {
    const events = await tx.query.prReviewEvents.findMany({
      where: and(
        eq(prReviewEvents.sourceControlProvider, input.sourceControlProvider),
        eq(prReviewEvents.repository, input.repository),
        eq(prReviewEvents.prNumber, input.prNumber),
        gte(prReviewEvents.receivedAt, since),
        lte(prReviewEvents.receivedAt, linkedAt),
      ),
      orderBy: [asc(prReviewEvents.receivedAt)],
    });
    const aggregateIds: string[] = [];

    for (const event of events) {
      aggregateIds.push(
        await fanOutEventToTask(tx, { event, taskId: input.taskId }),
      );
    }

    return [...new Set(aggregateIds)];
  });
}

export async function listPrReviewAggregateIdsNeedingDelivery(
  now = new Date(),
  limit = 100,
): Promise<string[]> {
  const staleSendingBefore = new Date(now.getTime() - 2 * 60_000);
  const rows = await db
    .select({ aggregateId: prReviewNotificationDeliveries.aggregateId })
    .from(prReviewNotificationDeliveries)
    .innerJoin(
      prReviewAggregates,
      eq(prReviewAggregates.id, prReviewNotificationDeliveries.aggregateId),
    )
    .where(
      and(
        or(
          inArray(prReviewNotificationDeliveries.state, [
            'waiting_for_idle',
            'pending',
            'failed',
          ]),
          and(
            inArray(prReviewNotificationDeliveries.state, [
              'delivered',
              'skipped',
              'dead_letter',
            ]),
            sql`${prReviewNotificationDeliveries.aggregateVersion} < ${prReviewAggregates.version}`,
          ),
          and(
            eq(prReviewNotificationDeliveries.state, 'sending'),
            lte(prReviewNotificationDeliveries.updatedAt, staleSendingBefore),
          ),
        ),
        or(
          sql`${prReviewNotificationDeliveries.nextAttemptAt} is null`,
          lte(prReviewNotificationDeliveries.nextAttemptAt, now),
        ),
      ),
    )
    .groupBy(prReviewNotificationDeliveries.aggregateId)
    .limit(limit);

  return rows.map((row) => row.aggregateId);
}

export async function getPrReviewAggregateDelivery(
  aggregateId: string,
): Promise<{
  aggregate: typeof prReviewAggregates.$inferSelect;
  deliveries: Array<typeof prReviewNotificationDeliveries.$inferSelect>;
} | null> {
  const aggregate = await db.query.prReviewAggregates.findFirst({
    where: eq(prReviewAggregates.id, aggregateId),
  });

  if (!aggregate) {
    return null;
  }

  const deliveries = await db.query.prReviewNotificationDeliveries.findMany({
    where: eq(prReviewNotificationDeliveries.aggregateId, aggregateId),
  });

  return { aggregate, deliveries };
}

export async function updatePrReviewAggregateTriage(input: {
  aggregateId: string;
  expectedVersion: number;
  summary: string;
  followUpQuestion: string | null;
  followUpPrompt: string | null;
}): Promise<boolean> {
  const [updated] = await db
    .update(prReviewAggregates)
    .set({
      summary: input.summary,
      followUpQuestion: input.followUpQuestion,
      followUpPrompt: input.followUpPrompt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prReviewAggregates.id, input.aggregateId),
        eq(prReviewAggregates.version, input.expectedVersion),
      ),
    )
    .returning({ id: prReviewAggregates.id });

  return Boolean(updated);
}

export async function prunePrReviewNotificationState(
  olderThan: Date,
): Promise<void> {
  await db.execute(sql`
    delete from ${prReviewAggregates} aggregate
    where aggregate.updated_at <= ${olderThan}
      and not exists (
        select 1
        from ${prReviewNotificationDeliveries} delivery
        where delivery.aggregate_id = aggregate.id
          and delivery.state not in ('delivered', 'skipped', 'unknown', 'dead_letter')
      )
  `);
  await db
    .delete(prReviewEvents)
    .where(lte(prReviewEvents.receivedAt, olderThan));
}

export async function markPrReviewDeliveriesEligible(
  aggregateId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(prReviewNotificationDeliveries)
    .set({
      state: 'pending',
      eligibleAt: sql`coalesce(${prReviewNotificationDeliveries.eligibleAt}, ${now})`,
      nextAttemptAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(prReviewNotificationDeliveries.aggregateId, aggregateId),
        eq(prReviewNotificationDeliveries.state, 'waiting_for_idle'),
      ),
    );
}

export async function updatePrReviewDelivery(input: {
  aggregateId: string;
  destination: 'task_history' | 'chat';
  state: PrReviewNotificationDeliveryState;
  aggregateVersion?: number;
  attemptCount?: number;
  nextAttemptAt?: Date | null;
  lastError?: string | null;
  alertEmittedAt?: Date | null;
  deliveredAt?: Date | null;
  chatProvider?: typeof prReviewNotificationDeliveries.$inferInsert.chatProvider;
  chatChannelId?: string | null;
  chatThreadId?: string | null;
  chatServiceUrl?: string | null;
  chatMessageId?: string | null;
  actionNonce?: string | null;
  actionHandledAt?: Date | null;
  taskMessageId?: string | null;
}): Promise<void> {
  await db
    .update(prReviewNotificationDeliveries)
    .set({
      state: input.state,
      ...(input.aggregateVersion !== undefined
        ? { aggregateVersion: input.aggregateVersion }
        : {}),
      ...(input.attemptCount !== undefined
        ? { attemptCount: input.attemptCount }
        : {}),
      ...(input.nextAttemptAt !== undefined
        ? { nextAttemptAt: input.nextAttemptAt }
        : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      ...(input.alertEmittedAt !== undefined
        ? { alertEmittedAt: input.alertEmittedAt }
        : {}),
      ...(input.deliveredAt !== undefined
        ? { deliveredAt: input.deliveredAt }
        : {}),
      ...(input.chatProvider !== undefined
        ? { chatProvider: input.chatProvider }
        : {}),
      ...(input.chatChannelId !== undefined
        ? { chatChannelId: input.chatChannelId }
        : {}),
      ...(input.chatThreadId !== undefined
        ? { chatThreadId: input.chatThreadId }
        : {}),
      ...(input.chatServiceUrl !== undefined
        ? { chatServiceUrl: input.chatServiceUrl }
        : {}),
      ...(input.chatMessageId !== undefined
        ? { chatMessageId: input.chatMessageId }
        : {}),
      ...(input.actionNonce !== undefined
        ? { actionNonce: input.actionNonce }
        : {}),
      ...(input.actionHandledAt !== undefined
        ? { actionHandledAt: input.actionHandledAt }
        : {}),
      ...(input.taskMessageId !== undefined
        ? { taskMessageId: input.taskMessageId }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prReviewNotificationDeliveries.aggregateId, input.aggregateId),
        eq(prReviewNotificationDeliveries.destination, input.destination),
      ),
    );
}

export async function claimDurablePrReviewAction(nonce: string): Promise<
  | { outcome: 'already_handled' }
  | {
      outcome: 'claimed';
      action: {
        taskId: string;
        repository: string;
        prNumber: number;
        prUrl: string;
        provider: 'slack' | 'discord' | 'telegram';
        channelId: string;
        threadId: string | null;
        followUpPrompt: string;
        messageId: string | null;
      };
    }
  | null
> {
  const existing = await db.query.prReviewNotificationDeliveries.findFirst({
    where: and(
      eq(prReviewNotificationDeliveries.destination, 'chat'),
      eq(prReviewNotificationDeliveries.actionNonce, nonce),
    ),
    columns: { actionHandledAt: true },
  });
  if (!existing) {
    return null;
  }
  if (existing.actionHandledAt) {
    return { outcome: 'already_handled' };
  }
  const [claimed] = await db
    .update(prReviewNotificationDeliveries)
    .set({ actionHandledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(prReviewNotificationDeliveries.destination, 'chat'),
        eq(prReviewNotificationDeliveries.actionNonce, nonce),
        sql`${prReviewNotificationDeliveries.actionHandledAt} is null`,
      ),
    )
    .returning({
      aggregateId: prReviewNotificationDeliveries.aggregateId,
      provider: prReviewNotificationDeliveries.chatProvider,
      channelId: prReviewNotificationDeliveries.chatChannelId,
      threadId: prReviewNotificationDeliveries.chatThreadId,
      messageId: prReviewNotificationDeliveries.chatMessageId,
    });
  if (
    !claimed?.provider ||
    !['slack', 'discord', 'telegram'].includes(claimed.provider) ||
    !claimed.channelId
  ) {
    return { outcome: 'already_handled' };
  }
  const aggregate = await db.query.prReviewAggregates.findFirst({
    where: eq(prReviewAggregates.id, claimed.aggregateId),
  });
  if (!aggregate?.followUpPrompt) {
    return { outcome: 'already_handled' };
  }
  return {
    outcome: 'claimed',
    action: {
      taskId: aggregate.taskId,
      repository: aggregate.repository,
      prNumber: aggregate.prNumber,
      prUrl: aggregate.prUrl,
      provider: claimed.provider as 'slack' | 'discord' | 'telegram',
      channelId: claimed.channelId,
      threadId: claimed.threadId,
      followUpPrompt: aggregate.followUpPrompt,
      messageId: claimed.messageId,
    },
  };
}

export async function acquirePrReviewFixClaim(input: {
  taskId: string;
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  aggregateId?: string;
  action: string;
  actingUserId?: string;
}): Promise<
  | { acquired: true; claimId: string }
  | { acquired: false; runId: number | null }
> {
  const [claim] = await db
    .insert(prReviewFixClaims)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: prReviewFixClaims.id });

  if (claim) {
    return { acquired: true, claimId: claim.id };
  }

  const existing = await db.query.prReviewFixClaims.findFirst({
    where: and(
      eq(prReviewFixClaims.sourceControlProvider, input.sourceControlProvider),
      eq(prReviewFixClaims.repository, input.repository),
      eq(prReviewFixClaims.prNumber, input.prNumber),
    ),
    columns: { runId: true },
  });

  return { acquired: false, runId: existing?.runId ?? null };
}

export async function attachRunToPrReviewFixClaim(
  claimId: string,
  runId: number,
): Promise<void> {
  await db
    .update(prReviewFixClaims)
    .set({ runId, updatedAt: new Date() })
    .where(eq(prReviewFixClaims.id, claimId));
}

export async function releasePrReviewFixClaim(claimId: string): Promise<void> {
  await db.delete(prReviewFixClaims).where(eq(prReviewFixClaims.id, claimId));
}

export async function releasePrReviewFixClaimsForRun(
  runId: number,
): Promise<void> {
  await db.delete(prReviewFixClaims).where(eq(prReviewFixClaims.runId, runId));
}

export async function releaseStalePrReviewFixClaims(
  now = new Date(),
): Promise<number> {
  const rows = await db
    .select({
      claimId: prReviewFixClaims.id,
      runId: prReviewFixClaims.runId,
      acquiredAt: prReviewFixClaims.acquiredAt,
      status: taskRuns.status,
      taskPhase: taskRuns.taskPhase,
      workerHeartbeatAt: taskRuns.workerHeartbeatAt,
    })
    .from(prReviewFixClaims)
    .leftJoin(taskRuns, eq(taskRuns.id, prReviewFixClaims.runId));
  const staleClaimIds = rows
    .filter((row) => {
      if (!row.runId) {
        return now.getTime() - row.acquiredAt.getTime() >= 2 * 60_000;
      }
      if (!row.status || !isTaskExecutingTurn(row.status, row.taskPhase)) {
        return true;
      }
      return (
        row.workerHeartbeatAt != null &&
        now.getTime() - row.workerHeartbeatAt.getTime() >=
          WORKER_HEARTBEAT_STALE_MS
      );
    })
    .map((row) => row.claimId);

  if (staleClaimIds.length > 0) {
    await db
      .delete(prReviewFixClaims)
      .where(inArray(prReviewFixClaims.id, staleClaimIds));
  }
  return staleClaimIds.length;
}
