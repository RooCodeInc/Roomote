import { redactSecrets } from '@roomote/communication/redact-secrets';
import { canRetryFailedStart, getTaskUrl } from '@roomote/cloud-agents/server';
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
import { listFastAgentPullRequestContexts } from '../fast-agent-parent-event';
import { enqueueFastAgentParentEvent } from '../fast-agent-parent-event-queue';
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

function getCustomAutomationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const value = (payload as { customAutomationId?: unknown })
    .customAutomationId;
  return typeof value === 'string' && value ? value : undefined;
}
function formatFastAgentTerminalError(run: TaskRun): string {
  const error = run.error?.trim();
  if (!error) {
    return 'The task stopped without a detailed error. Open the task for diagnostics.';
  }

  return redactSecrets(error);
}

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

  try {
    const pullRequests = await listFastAgentPullRequestContexts(run.taskId);
    const customAutomationId = getCustomAutomationId(run.payload);
    let retryTaskStartRunId: number | undefined;

    if (status === RunStatus.Failed) {
      try {
        if (await canRetryFailedStart({ ...run, status: RunStatus.Failed })) {
          retryTaskStartRunId = run.id;
        }
      } catch (error) {
        console.warn(
          `[notifyFastAgentParentOnSettle] Could not determine failed-start retry eligibility for run ${run.id}; delivering the failure without retry control: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await enqueueFastAgentParentEvent({
      parent,
      ...(retryTaskStartRunId ? { retryTaskStartRunId } : {}),
      event: {
        type: 'task_settled',
        taskId: run.taskId,
        runId: run.id,
        ...(customAutomationId ? { customAutomationId } : {}),
        ...(taskTitle?.trim() ? { title: taskTitle.trim() } : {}),
        status,
        ...(status === RunStatus.Failed || status === RunStatus.Canceled
          ? {
              error: formatFastAgentTerminalError(run),
              ...(run.errorCode ? { errorCode: run.errorCode } : {}),
            }
          : {}),
        taskUrl: getTaskUrl({
          taskId: run.taskId,
          utm: {
            source: parent.conversation.surface,
            campaign: 'fast-delegation-settle',
          },
        }),
        pullRequests,
      },
    });
    await markSettled();

    await recordTaskRunLifecycleEvent(db, {
      runId: run.id,
      taskId: run.taskId,
      eventType: 'decision',
      message: `Queued ${status} lifecycle state for the Fast parent orchestrator.`,
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
