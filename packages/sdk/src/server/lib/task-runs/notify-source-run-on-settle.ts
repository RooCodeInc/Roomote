import {
  RunStatus,
  getNotifySourceRunOnSettleFromPayload,
  isExitedRunStatus,
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

import { withSandboxServerRpcClient } from '../auth/sandbox-server-rpc';

const NOTIFIED_RESULT_KEY = 'sourceRunSettleNotifiedAt';

type SettledStatus =
  | RunStatus.Completed
  | RunStatus.Failed
  | RunStatus.Canceled
  | RunStatus.Idle;

function getSettleStatusLabel(status: SettledStatus): string {
  switch (status) {
    case RunStatus.Completed:
      return 'completed';
    case RunStatus.Failed:
      return 'failed';
    case RunStatus.Canceled:
      return 'was canceled';
    case RunStatus.Idle:
      return 'finished its turn and is now idle';
  }
}

function buildSettleNotificationPrompt(input: {
  taskId: string;
  taskTitle: string | null;
  status: SettledStatus;
  environmentSetupState: string | null;
  error: string | null;
}): string {
  const lines = [
    `Spawned task update: the task you launched (${input.taskTitle ? `"${input.taskTitle}", ` : ''}ID ${input.taskId}) ${getSettleStatusLabel(input.status)}.`,
  ];

  if (input.environmentSetupState) {
    lines.push(
      `Its environment setup state is: ${input.environmentSetupState.replace(/_/g, ' ')}.`,
    );
  }

  if (input.error) {
    lines.push(`Reported error: ${input.error}`);
  }

  lines.push(
    `Use the Roomote MCP tool \`mcp__roomote__manage_tasks\` with action "get_summary" or "get_messages" and taskId ${input.taskId} for the full outcome, then continue your workflow. This is an automated platform notification, not a user message.`,
  );

  return lines.join('\n');
}

/**
 * Deliver a spawned task's settle outcome into the session of the run that
 * launched it.
 *
 * Opt-in at launch time (`notifyOnSettle`) persists
 * `notifySourceRunOnSettle` on the spawned task's payload and stamps
 * `sourceRunId` with the launching run. When a run of the spawned task
 * settles, this injects a prompt into the launching run's sandbox — waking
 * it if it went idle — so a parent workflow (e.g. environment-setup waiting
 * on its verification task) consumes the outcome deterministically instead
 * of polling and potentially sleeping through it.
 *
 * Fire-and-forget: failures are logged and recorded as run events, never
 * thrown, and delivery happens at most once per spawned run (guarded via the
 * run's `result` JSON).
 */
export async function notifySourceRunOnSettle(
  run: TaskRun & { task: { title: string | null } },
  status: SettledStatus,
): Promise<void> {
  try {
    if (
      !run.sourceRunId ||
      !getNotifySourceRunOnSettleFromPayload(run.payload)
    ) {
      return;
    }

    const sourceRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.sourceRunId),
      columns: {
        id: true,
        taskId: true,
        status: true,
        sandboxServerUrl: true,
      },
    });

    // sourceRunId is also used by same-task resume chains; only cross-task
    // spawns get a notification.
    if (
      !sourceRun ||
      sourceRun.taskId === run.taskId ||
      isExitedRunStatus(sourceRun.status) ||
      !sourceRun.sandboxServerUrl
    ) {
      return;
    }

    // Atomically claim delivery before sending: a conditional JSONB update
    // that only succeeds while the marker is absent, so concurrent
    // finalizations (e.g. idle racing a later completed) cannot both send.
    // A claim whose send then fails is not retried — at-most-once — and the
    // failure is recorded as a run event below.
    const claimed = await db
      .update(taskRuns)
      .set({
        result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${NOTIFIED_RESULT_KEY}::text, to_jsonb(now()))`,
      })
      .where(
        and(
          eq(taskRuns.id, run.id),
          sql`(${taskRuns.result} -> ${NOTIFIED_RESULT_KEY}) is null`,
        ),
      )
      .returning({ id: taskRuns.id });

    if (claimed.length === 0) {
      return;
    }

    const prompt = buildSettleNotificationPrompt({
      taskId: run.taskId,
      taskTitle: run.task.title,
      status,
      environmentSetupState: run.environmentSetupState ?? null,
      error: run.error ?? null,
    });

    await withSandboxServerRpcClient({
      runId: sourceRun.id,
      // Deployment-service-principal token: this is a platform notification
      // with no human actor, so the receiving turn keeps its current actor.
      userId: null,
      sandboxServerUrl: sourceRun.sandboxServerUrl,
      call: (client) =>
        client.commands.sendPrompt.mutate({
          prompt,
          source: 'task-settled',
          // Platform machinery: the agent must see it, the user should not.
          visibleInTranscript: false,
        }),
    });

    await recordTaskRunLifecycleEvent(db, {
      runId: run.id,
      taskId: run.taskId,
      eventType: 'decision',
      message: `Delivered settle notification (${status}) to launching run #${sourceRun.id}.`,
      details: {
        reason: 'source_run_settle_notification',
        sourceRunId: sourceRun.id,
        status,
      },
    });
  } catch (error) {
    console.error(
      `[notifySourceRunOnSettle] Failed to notify source run for run ${run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    try {
      await recordTaskRunLifecycleEvent(db, {
        runId: run.id,
        taskId: run.taskId,
        eventType: 'decision',
        message: `Failed to deliver settle notification to launching run #${run.sourceRunId}.`,
        details: {
          reason: 'source_run_settle_notification_failed',
          sourceRunId: run.sourceRunId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // Best-effort observability only.
    }
  }
}
