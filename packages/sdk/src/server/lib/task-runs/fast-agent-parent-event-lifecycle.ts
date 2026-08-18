import { type SQL, and, db, eq, sql, taskRuns } from '@roomote/db/server';

import { FastAgentParentEventDeliveryError } from '../fast-agent-parent-event';
import {
  buildFastAgentDeliveringMarker,
  buildFastAgentDeliveryClaimPredicate,
} from './fast-agent-delivery-claim';

type DeliveryMarker = 'timestamp' | 'delivered' | 'skipped';

export type FastAgentParentEventLifecycleResult =
  | { status: 'not_claimed' }
  | { status: 'delivered' }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown };

/** Own the leased claim, delivery classification, and final marker for one event. */
export async function runFastAgentParentEventLifecycle(params: {
  runId: number;
  deliveryKey: string;
  claimPredicates?: SQL[];
  deliveredMarker?: DeliveryMarker;
  permanentFailureMarker?: DeliveryMarker;
  deliver: () => Promise<'delivered' | 'skipped' | void>;
  recordDelivered: () => Promise<unknown>;
}): Promise<FastAgentParentEventLifecycleResult> {
  const claimMarker = buildFastAgentDeliveringMarker();
  const ownsClaim = sql`${taskRuns.result} ->> ${params.deliveryKey} = ${claimMarker}`;
  const writeMarker = async (marker: DeliveryMarker) => {
    await db
      .update(taskRuns)
      .set({
        result:
          marker === 'timestamp'
            ? sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${params.deliveryKey}::text, to_jsonb(now()))`
            : sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${params.deliveryKey}::text, ${marker}::text)`,
      })
      .where(and(eq(taskRuns.id, params.runId), ownsClaim));
  };
  const deliveredMarker = params.deliveredMarker ?? 'timestamp';
  const permanentFailureMarker =
    params.permanentFailureMarker ?? deliveredMarker;
  const claimRows = await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${params.deliveryKey}::text, ${claimMarker}::text)`,
    })
    .where(
      and(
        eq(taskRuns.id, params.runId),
        buildFastAgentDeliveryClaimPredicate(params.deliveryKey),
        ...(params.claimPredicates ?? []),
      ),
    )
    .returning({ id: taskRuns.id });

  if (claimRows.length === 0) {
    return { status: 'not_claimed' };
  }

  let delivered = false;

  try {
    const result = await params.deliver();
    if (result === 'skipped') {
      await writeMarker(permanentFailureMarker);
      return { status: 'skipped' };
    }
    delivered = true;

    await writeMarker(deliveredMarker);
    await params.recordDelivered();
    return { status: 'delivered' };
  } catch (error) {
    const deliveryError =
      error instanceof FastAgentParentEventDeliveryError ? error : null;

    if (delivered || deliveryError?.slackPosted) {
      await writeMarker(deliveredMarker).catch(() => {});
      return { status: 'delivered' };
    }

    if (deliveryError?.permanent) {
      await writeMarker(permanentFailureMarker).catch(() => {});
      return { status: 'skipped' };
    }

    try {
      await db
        .update(taskRuns)
        .set({
          result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${params.deliveryKey}`,
        })
        .where(and(eq(taskRuns.id, params.runId), ownsClaim));
    } catch {
      // Best-effort release lets a later caller reclaim a transient failure.
    }
    return { status: 'failed', error };
  }
}
