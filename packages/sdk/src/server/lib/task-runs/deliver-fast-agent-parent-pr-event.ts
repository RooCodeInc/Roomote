import {
  type SQL,
  and,
  asc,
  db,
  desc,
  eq,
  sql,
  taskRuns,
} from '@roomote/db/server';

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
}): Promise<void> {
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

  let delivered = false;
  try {
    const delivery = await params.deliver();
    if (delivery === 'skipped') {
      await markDelivered();
      return;
    }
    delivered = true;

    await markDelivered();
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
      await markDelivered().catch(() => {});
      return;
    }

    try {
      await db
        .update(taskRuns)
        .set({
          result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${params.deliveryKey}`,
        })
        .where(eq(taskRuns.id, claimRun.id));
    } catch {
      // Best-effort claim release for a later retry.
    }
    throw error;
  }
}
