import {
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
}): Promise<void> {
  if (params.conversationClaim) {
    const claim = await claimFastAgentPrFeedbackDelivery({
      conversation: params.conversationClaim.conversation,
      feedbackId: params.conversationClaim.feedbackId,
      taskId: params.run.taskId,
    });
    if (!claim) {
      return;
    }

    return deliverClaimedFastAgentParentPrEvent({
      ...params,
      markDelivered: () => completeFastAgentPrFeedbackDelivery(claim),
      releaseClaim: () => releaseFastAgentPrFeedbackDelivery(claim),
    });
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

  return deliverClaimedFastAgentParentPrEvent({
    ...params,
    markDelivered,
    releaseClaim: async () => {
      await db
        .update(taskRuns)
        .set({
          result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${params.deliveryKey}`,
        })
        .where(eq(taskRuns.id, claimRun.id));
    },
  });
}

async function deliverClaimedFastAgentParentPrEvent(params: {
  run: { id: number };
  deliver: () => Promise<'delivered' | 'skipped'>;
  recordLifecycle: () => Promise<unknown>;
  logPrefix: string;
  markDelivered: () => Promise<void>;
  releaseClaim: () => Promise<void>;
}): Promise<void> {
  let delivered = false;
  try {
    const delivery = await params.deliver();
    if (delivery === 'skipped') {
      await params.markDelivered();
      return;
    }
    delivered = true;

    await params.markDelivered();
    await params.recordLifecycle();
  } catch (error) {
    console.error(
      `[${params.logPrefix}] Failed for run ${params.run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const deliveryError =
      error instanceof FastAgentParentEventDeliveryError ? error : null;

    if (delivered || deliveryError?.replyPosted || deliveryError?.permanent) {
      await params.markDelivered().catch(() => {});
      return;
    }

    try {
      await params.releaseClaim();
    } catch {
      // Best-effort claim release for a later retry.
    }
    throw error;
  }
}
