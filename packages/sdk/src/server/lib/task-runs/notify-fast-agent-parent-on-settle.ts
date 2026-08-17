import { RunStatus, getFastAgentParentFromPayload } from '@roomote/types';
import {
  type TaskRun,
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  sql,
  taskRuns,
} from '@roomote/db/server';
import { getTaskUrl } from '@roomote/cloud-agents/server';

import {
  FastAgentParentEventDeliveryError,
  deliverFastAgentParentEvent,
} from '../fast-agent-parent-event';
import {
  buildFastAgentDeliveringMarker,
  buildFastAgentDeliveryClaimPredicate,
} from './fast-agent-delivery-claim';

const NOTIFIED_RESULT_KEY = 'fastAgentParentSettleNotifiedAt';

type SettledStatus =
  | RunStatus.Completed
  | RunStatus.Failed
  | RunStatus.Canceled
  | RunStatus.Idle;

/** Pass a Fast child's terminal/idle state to its conversational orchestrator. */
export async function notifyFastAgentParentOnSettle(
  run: TaskRun,
  status: SettledStatus,
  taskTitle?: string | null,
): Promise<void> {
  const parent = getFastAgentParentFromPayload(run.payload);
  if (!parent) {
    return;
  }

  const markSettled = async () => {
    await db
      .update(taskRuns)
      .set({
        result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${NOTIFIED_RESULT_KEY}::text, to_jsonb(now()))`,
      })
      .where(eq(taskRuns.id, run.id));
  };
  const claimRows = await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${NOTIFIED_RESULT_KEY}::text, ${buildFastAgentDeliveringMarker()}::text)`,
    })
    .where(
      and(
        eq(taskRuns.id, run.id),
        buildFastAgentDeliveryClaimPredicate(NOTIFIED_RESULT_KEY),
      ),
    )
    .returning({ id: taskRuns.id });

  if (claimRows.length === 0) {
    return;
  }

  let delivered = false;

  try {
    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'task_settled',
        taskId: run.taskId,
        runId: run.id,
        ...(taskTitle?.trim() ? { title: taskTitle.trim() } : {}),
        status,
        taskUrl: getTaskUrl({
          taskId: run.taskId,
          utm: { source: 'slack', campaign: 'fast-delegation-settle' },
        }),
      },
    });
    delivered = true;

    await markSettled();

    await recordTaskRunLifecycleEvent(db, {
      runId: run.id,
      taskId: run.taskId,
      eventType: 'decision',
      message: `Passed ${status} lifecycle state to the Fast parent orchestrator.`,
      details: {
        reason: 'fast_agent_parent_settle_event',
        fastAgentSessionId: parent.sessionId,
        status,
      },
    });
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnSettle] Failed for run ${run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const deliveryError =
      error instanceof FastAgentParentEventDeliveryError ? error : null;

    if (delivered || deliveryError?.slackPosted) {
      // The parent thread already saw the settle message; releasing the claim
      // would let the other settle caller double-post. Settle the marker.
      await markSettled().catch(() => {});
      return;
    }

    if (deliveryError?.permanent) {
      // No retry can succeed (parent session or installation gone).
      await markSettled().catch(() => {});
      return;
    }

    try {
      await db
        .update(taskRuns)
        .set({
          result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${NOTIFIED_RESULT_KEY}`,
        })
        .where(eq(taskRuns.id, run.id));
    } catch {
      // Best-effort claim release for retry.
    }
  }
}
