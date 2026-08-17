import { setTimeout as delay } from 'node:timers/promises';

import { redactSecrets } from '@roomote/communication/redact-secrets';
import {
  canRetryFailedStart,
  enqueueTaskRelaunch,
  getTaskUrl,
} from '@roomote/cloud-agents/server';
import {
  RunStatus,
  TaskRunErrorCode,
  getFastAgentParentFromPayload,
  type FastAgentParent,
  type TaskRunErrorCode as TaskRunErrorCodeValue,
} from '@roomote/types';
import {
  type TaskRun,
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
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

const NOTIFIED_RESULT_KEY = 'fastAgentParentSettleNotifiedAt';
const FAST_AGENT_STARTUP_MAX_RETRIES = 2;
const FAST_AGENT_STARTUP_RETRY_BASE_DELAY_MS = 1_000;
const FAST_AGENT_ERROR_MAX_CHARS = 300;

const TRANSIENT_STARTUP_ERROR_CODES = new Set<TaskRunErrorCodeValue>([
  TaskRunErrorCode.DockerDaemonUnreachable,
  TaskRunErrorCode.DockerWorkerStartTimeout,
  TaskRunErrorCode.DockerWorkerExitedEarly,
  TaskRunErrorCode.DockerWorkerFetchFailed,
]);
const PERMANENT_STARTUP_ERROR_PATTERN =
  /\b(?:unauthorized|forbidden|invalid (?:api )?key|invalid credential|authentication failed|permission denied|not configured|configuration|unsupported|not found|missing|required|read[ -]?only|spend limit|quota|billing|address pool exhausted|port is already (?:allocated|in use))\b/i;
const TRANSIENT_STARTUP_ERROR_PATTERN =
  /\b(?:timed? out|timeout|temporar(?:y|ily)|unavailable|rate limit|too many requests|connection (?:closed|refused|reset)|network error|socket hang up|fetch failed|econnreset|econnrefused|enotfound|http (?:408|429|5\d\d)|status (?:408|429|5\d\d)|machine unavailable)\b/i;

type SettledStatus =
  | RunStatus.Completed
  | RunStatus.Failed
  | RunStatus.Canceled
  | RunStatus.Idle;

function isTransientFastAgentStartupFailure(run: TaskRun): boolean {
  const error = run.error?.trim();
  if (error && PERMANENT_STARTUP_ERROR_PATTERN.test(error)) {
    return false;
  }

  if (run.errorCode) {
    return TRANSIENT_STARTUP_ERROR_CODES.has(run.errorCode);
  }

  if (!error) {
    return false;
  }

  return TRANSIENT_STARTUP_ERROR_PATTERN.test(error);
}

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

async function retryTransientFastAgentStartup(
  run: TaskRun,
  parent: FastAgentParent,
): Promise<boolean> {
  if (
    !isTransientFastAgentStartupFailure(run) ||
    !(await canRetryFailedStart({ ...run, status: RunStatus.Failed }))
  ) {
    return false;
  }

  const retries = await countFastAgentStartupRetries(run, parent);
  if (retries >= FAST_AGENT_STARTUP_MAX_RETRIES) {
    return false;
  }

  const retryNumber = retries + 1;
  const delayMs =
    FAST_AGENT_STARTUP_RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1);

  await delay(delayMs);
  await enqueueTaskRelaunch({
    sourceRunId: run.id,
    actingUserId: run.actingUserId,
  });
  await recordTaskRunLifecycleEvent(db, {
    runId: run.id,
    taskId: run.taskId,
    eventType: 'decision',
    message: `Automatically retried transient Fast child sandbox startup (${retryNumber}/${FAST_AGENT_STARTUP_MAX_RETRIES}).`,
    details: {
      reason: 'fast_agent_transient_startup_retry',
      fastAgentSessionId: parent.sessionId,
      retryNumber,
      maxRetries: FAST_AGENT_STARTUP_MAX_RETRIES,
      delayMs,
    },
  }).catch((error) => {
    console.warn(
      `[notifyFastAgentParentOnSettle] Failed to record automatic startup retry for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return true;
}

function formatFastAgentTerminalError(run: TaskRun): string {
  const firstLine = run.error?.split(/\r?\n/u, 1)[0]?.trim();
  if (!firstLine) {
    return 'The task stopped without a detailed error. Open the task for diagnostics.';
  }

  const safeError = redactSecrets(firstLine).replace(
    /https?:\/\/\S+/giu,
    '[redacted URL]',
  );

  return safeError.length > FAST_AGENT_ERROR_MAX_CHARS
    ? `${safeError.slice(0, FAST_AGENT_ERROR_MAX_CHARS - 1)}…`
    : safeError;
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

  let delivered = false;

  try {
    if (status === RunStatus.Failed) {
      try {
        if (await retryTransientFastAgentStartup(run, parent)) {
          await markSettled();
          return;
        }
      } catch (error) {
        console.warn(
          `[notifyFastAgentParentOnSettle] Automatic startup retry failed for run ${run.id}; reporting the terminal failure: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const pullRequests = await listFastAgentPullRequestContexts(run.taskId);
    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'task_settled',
        taskId: run.taskId,
        runId: run.id,
        ...(taskTitle?.trim() ? { title: taskTitle.trim() } : {}),
        status,
        ...(status === RunStatus.Failed || status === RunStatus.Canceled
          ? { error: formatFastAgentTerminalError(run) }
          : {}),
        taskUrl: getTaskUrl({
          taskId: run.taskId,
          utm: { source: 'slack', campaign: 'fast-delegation-settle' },
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
