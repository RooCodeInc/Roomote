import { setTimeout as delay } from 'node:timers/promises';

import {
  canRetryFailedStart,
  enqueueTaskRelaunch,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  taskRuns,
  type TaskRun,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
  RunStatus,
  type FastAgentParent,
} from '@roomote/types';

const FAST_AGENT_STARTUP_MAX_RETRIES = 2;
const FAST_AGENT_STARTUP_RETRY_BASE_DELAY_MS = 1_000;

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

export async function retryFastAgentStartup(
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
      `[FastAgentStartupRetry] Failed to record parent-requested startup retry for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return { success: true, runId: relaunchedRun.id };
}
