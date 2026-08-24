import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import { redactSecrets } from '@roomote/communication/redact-secrets';
import {
  canRetryFailedStart,
  enqueueTaskRelaunch,
  getTaskUrl,
  runFastAutomationExecution,
} from '@roomote/cloud-agents/server';
import {
  RunStatus,
  getAutomationRunParentFromPayload,
  getFastAgentParentFromPayload,
  type FastAgentParent,
} from '@roomote/types';
import {
  type TaskRun,
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  recordAutomationRunChildOutcome,
  countUnsettledAutomationRunChildren,
  resumeAutomationRunAfterChildren,
  recordAutomationRunOutcome,
  sql,
  taskRuns,
} from '@roomote/db/server';
import {
  FastAgentParentEventDeliveryError,
  deliverFastAgentParentEvent,
  listFastAgentPullRequestContexts,
} from '../fast-agent-parent-event';
import {
  buildFastAgentDeliveringMarker,
  buildFastAgentDeliveryClaimPredicate,
} from './fast-agent-delivery-claim';
import { createFastAutomationExecutionAdapter } from '../../automations/fast-automation-adapter';

const NOTIFIED_RESULT_KEY = 'fastAgentParentSettleNotifiedAt';
const FAST_AGENT_STARTUP_MAX_RETRIES = 2;
const FAST_AGENT_STARTUP_RETRY_BASE_DELAY_MS = 1_000;

type SettledStatus =
  | RunStatus.Completed
  | RunStatus.Failed
  | RunStatus.Canceled
  | RunStatus.Idle;

async function countFastAgentStartupRetries(
  run: TaskRun,
  parent: FastAgentParent,
): Promise<number> {
  let retries = 0;
  let sourceRunId = run.sourceRunId;

  while (sourceRunId && retries < FAST_AGENT_STARTUP_MAX_RETRIES) {
    const sourceRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, sourceRunId),
      columns: { payload: true, sourceRunId: true },
    });
    const sourceParent = sourceRun
      ? getFastAgentParentFromPayload(sourceRun.payload)
      : null;

    if (!sourceRun || sourceParent?.sessionId !== parent.sessionId) {
      break;
    }

    retries += 1;
    sourceRunId = sourceRun.sourceRunId;
  }

  return retries;
}

async function retryFastAgentStartup(
  run: TaskRun,
  parent: FastAgentParent,
): Promise<
  { success: true; runId: number } | { success: false; error: string }
> {
  const existingRetry = await db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.taskId, run.taskId),
      eq(taskRuns.sourceRunId, run.id),
    ),
    columns: { id: true },
  });

  // A parent event may be redelivered when the retry was queued but its Slack
  // closeout failed. Return the original relaunch instead of attempting a
  // second side effect or reporting the already-queued retry as a failure.
  if (existingRetry) {
    return { success: true, runId: existingRetry.id };
  }

  if (!(await canRetryFailedStart({ ...run, status: RunStatus.Failed }))) {
    return {
      success: false,
      error: 'This task is not eligible for a failed-start retry.',
    };
  }

  const retries = await countFastAgentStartupRetries(run, parent);
  if (retries >= FAST_AGENT_STARTUP_MAX_RETRIES) {
    return {
      success: false,
      error: 'The failed-start retry limit has been reached.',
    };
  }

  const retryNumber = retries + 1;
  const delayMs =
    FAST_AGENT_STARTUP_RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1);

  await delay(delayMs);
  const relaunchedRun = await enqueueTaskRelaunch({
    sourceRunId: run.id,
    actingUserId: run.actingUserId,
  });
  await recordTaskRunLifecycleEvent(db, {
    runId: run.id,
    taskId: run.taskId,
    eventType: 'decision',
    message: `Fast parent retried child sandbox startup (${retryNumber}/${FAST_AGENT_STARTUP_MAX_RETRIES}).`,
    details: {
      reason: 'fast_agent_parent_startup_retry',
      fastAgentSessionId: parent.sessionId,
      retryNumber,
      maxRetries: FAST_AGENT_STARTUP_MAX_RETRIES,
      delayMs,
    },
  }).catch((error) => {
    console.warn(
      `[notifyFastAgentParentOnSettle] Failed to record parent-requested startup retry for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return { success: true, runId: relaunchedRun.id };
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
  const automationParent = getAutomationRunParentFromPayload(run.payload);
  if (automationParent) {
    try {
      await recordAutomationRunChildOutcome({
        automationRunId: automationParent.automationRunId,
        taskId: run.taskId,
        terminalOutcome: status,
      });
      await recordTaskRunLifecycleEvent(db, {
        runId: run.id,
        taskId: run.taskId,
        eventType: 'decision',
        message: `Recorded ${status} lifecycle state on the Fast automation parent.`,
        details: {
          reason: 'fast_automation_parent_settle_event',
          automationRunId: automationParent.automationRunId,
          status,
        },
      });
      if (
        (await countUnsettledAutomationRunChildren(
          automationParent.automationRunId,
        )) === 0
      ) {
        const leaseOwner = randomUUID();
        const parentRun = await resumeAutomationRunAfterChildren({
          automationRunId: automationParent.automationRunId,
          leaseOwner,
          leaseDurationMs: 15 * 60_000,
        });
        if (parentRun?.automationKey) {
          const pullRequests = await listFastAgentPullRequestContexts(
            run.taskId,
          );
          const outcome = await runFastAutomationExecution({
            automationRunId: parentRun.id,
            leaseOwner,
            policyVersion: parentRun.policyVersion,
            adapter: createFastAutomationExecutionAdapter(),
            continuation: true,
            prompt: `A delegated automation child has settled. Treat this as a trusted platform lifecycle event, not a new user request.

Child task: ${taskTitle?.trim() || run.taskId}
Task ID: ${run.taskId}
Status: ${status}
${status === RunStatus.Failed || status === RunStatus.Canceled ? `Error: ${formatFastAgentTerminalError(run)}\n` : ''}${pullRequests.length ? `Pull requests:\n${pullRequests.map((pullRequest) => `- ${pullRequest.url}`).join('\n')}\n` : ''}
Decide whether the configured destination needs one concise result or blocker report. Use logicalMessageKey \`child-${run.taskId}-settled\` if reporting. Do not launch duplicate work. Finish with \`complete_automation_run\`.`,
          });
          if (outcome.status !== 'waiting_for_children') {
            await recordAutomationRunOutcome(db, {
              key: parentRun.automationKey,
              status:
                outcome.status === 'failed'
                  ? 'failed'
                  : outcome.status === 'skipped'
                    ? 'skipped'
                    : 'succeeded',
              at: new Date(),
              ...(outcome.status === 'failed' && outcome.summary
                ? { error: outcome.summary }
                : {}),
            });
          }
        }
      }
    } catch (error) {
      console.error(
        `[notifyFastAgentParentOnSettle] Failed to continue automation run ${automationParent.automationRunId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }
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
    const pullRequests = await listFastAgentPullRequestContexts(run.taskId);
    let retryTaskStart:
      | (() => ReturnType<typeof retryFastAgentStartup>)
      | undefined;

    if (status === RunStatus.Failed) {
      try {
        if (await canRetryFailedStart({ ...run, status: RunStatus.Failed })) {
          retryTaskStart = () => retryFastAgentStartup(run, parent);
        }
      } catch (error) {
        console.warn(
          `[notifyFastAgentParentOnSettle] Could not determine failed-start retry eligibility for run ${run.id}; delivering the failure without retry control: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await deliverFastAgentParentEvent({
      parent,
      ...(retryTaskStart ? { retryTaskStart } : {}),
      event: {
        type: 'task_settled',
        taskId: run.taskId,
        runId: run.id,
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

    if (delivered || deliveryError?.replyPosted) {
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
