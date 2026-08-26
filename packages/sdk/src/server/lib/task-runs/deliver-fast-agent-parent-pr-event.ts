import {
  type FastAgentPrFeedbackDeliveryClaim,
  claimFastAgentPrFeedbackDelivery,
  completeFastAgentPrFeedbackDelivery,
  type SQL,
  and,
  asc,
  db,
  desc,
  eq,
  releaseFastAgentPrFeedbackDelivery,
  sql,
  taskRuns,
} from '@roomote/db/server';
import type { FastAgentConversation } from '@roomote/types';

import { FastAgentParentEventDeliveryError } from '../fast-agent-parent-event';
import {
  buildFastAgentDeliveringMarker,
  buildFastAgentDeliveryClaimPredicate,
} from './fast-agent-delivery-claim';

/** Own the shared claim and retry lifecycle for a Fast parent PR event. */
export async function deliverFastAgentParentPrEvent(params: {
  run: { id: number; taskId: string };
  deliveryKey: string;
  claimCondition?: SQL;
  deliver: () => Promise<'delivered' | 'skipped'>;
  recordLifecycle: () => Promise<unknown>;
  logPrefix: string;
  conversationClaim?: {
    conversation: Pick<
      FastAgentConversation,
      'surface' | 'workspaceId' | 'conversationId'
    >;
    feedbackId: string;
  };
  /** Canonical destination delivery already owns the external side effect. */
  canonicalDeliveryOwned?: boolean;
}): Promise<boolean | void> {
  if (params.canonicalDeliveryOwned) {
    return deliverClaimedFastAgentParentPrEvent({
      ...params,
      markDelivered: async () => true,
      releaseClaim: async () => undefined,
    });
  }

  let conversationClaim: FastAgentPrFeedbackDeliveryClaim | null = null;
  if (params.conversationClaim) {
    const claimResult = await claimFastAgentPrFeedbackDelivery({
      conversation: params.conversationClaim.conversation,
      feedbackId: params.conversationClaim.feedbackId,
      taskId: params.run.taskId,
    });
    if (claimResult.status === 'already_claimed') {
      return;
    }
    if (claimResult.status === 'no_conversation') {
      // The conversation row is the dedupe scope. Without it there is nothing
      // to deduplicate against, so fall through to the task-scoped claim
      // rather than silently dropping the event.
      console.warn(
        `[${params.logPrefix}] No Fast conversation row for ${params.conversationClaim.conversation.surface}:${params.conversationClaim.conversation.workspaceId}:${params.conversationClaim.conversation.conversationId}; falling back to the task-scoped delivery claim.`,
      );
    } else {
      conversationClaim = claimResult.claim;
    }
  }

  // Keep one claim row per task so a resume between two delivery paths cannot
  // make the same Fast event look new. Prefer a row that already owns this key
  // for compatibility with claims written before task-scoped delivery.
  const claimRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, params.run.taskId),
    orderBy: [
      desc(
        sql`coalesce(${taskRuns.result}, '{}'::jsonb) ? ${params.deliveryKey}`,
      ),
      asc(taskRuns.createdAt),
      asc(taskRuns.id),
    ],
    columns: { id: true },
  });
  if (!claimRun) {
    return;
  }

  const markDelivered = async () => {
    await db
      .update(taskRuns)
      .set({
        result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${params.deliveryKey}::text, to_jsonb(now()))`,
      })
      .where(eq(taskRuns.id, claimRun.id));
  };

  // A held conversation claim is already the single arbiter for this identity,
  // so it must not be double-gated on the task-scoped claim predicate. Stamp
  // the run row on success anyway so the delivery stays visible on the task.
  if (conversationClaim) {
    const claim = conversationClaim;
    await deliverClaimedFastAgentParentPrEvent({
      ...params,
      markDelivered: async () => {
        await completeFastAgentPrFeedbackDelivery(claim);
        await markDelivered();
        return true;
      },
      releaseClaim: () => releaseFastAgentPrFeedbackDelivery(claim),
    });
    return;
  }

  const claimRows = await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${params.deliveryKey}::text, ${buildFastAgentDeliveringMarker()}::text)`,
    })
    .where(
      and(
        eq(taskRuns.id, claimRun.id),
        params.claimCondition,
        buildFastAgentDeliveryClaimPredicate(params.deliveryKey),
      ),
    )
    .returning({ id: taskRuns.id });

  if (claimRows.length === 0) {
    return;
  }

  await deliverClaimedFastAgentParentPrEvent({
    ...params,
    markDelivered: async () => {
      await markDelivered();
      return true;
    },
    releaseClaim: async () => {
      await db
        .update(taskRuns)
        .set({
          result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${params.deliveryKey}`,
        })
        .where(eq(taskRuns.id, claimRun.id));
    },
  });
  return;
}

async function deliverClaimedFastAgentParentPrEvent(params: {
  run: { id: number };
  deliver: () => Promise<'delivered' | 'skipped'>;
  recordLifecycle: () => Promise<unknown>;
  logPrefix: string;
  markDelivered: () => Promise<boolean>;
  releaseClaim: () => Promise<void>;
}): Promise<boolean> {
  let delivered = false;
  try {
    const delivery = await params.deliver();
    if (delivery === 'skipped') {
      return params.markDelivered();
    }
    delivered = true;

    if (!(await params.markDelivered())) {
      return false;
    }
    await params.recordLifecycle();
    return true;
  } catch (error) {
    console.error(
      `[${params.logPrefix}] Failed for run ${params.run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const deliveryError =
      error instanceof FastAgentParentEventDeliveryError ? error : null;

    if (delivered || deliveryError?.replyPosted || deliveryError?.permanent) {
      return params.markDelivered().catch(() => false);
    }

    try {
      await params.releaseClaim();
    } catch {
      // Best-effort claim release for a later retry.
    }
    throw error;
  }
}
