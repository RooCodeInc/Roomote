import {
  buildTaskCancellationResponseBlocks,
  buildTaskNotRunningResponseBlocks,
  parseTaskCancellationActionValue,
  postSlackInteractiveResponse,
  TASK_CANCELED_RESPONSE_TEXT,
  type SlackInteractivePayload,
} from '@roomote/slack';
import { activeRunStatuses } from '@roomote/types';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  taskRuns,
} from '@roomote/db/server';

import { stopTaskRun } from '../../tasks/task-stop.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';

type CancelableTaskRunTarget = Parameters<typeof stopTaskRun>[0]['run'] & {
  taskId: string | null;
};

async function findLatestActiveTaskRunForTask(
  taskId: string,
): Promise<CancelableTaskRunTarget | null> {
  const activeRun = await db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.taskId, taskId),
      inArray(taskRuns.status, [...activeRunStatuses]),
      isNull(taskRuns.canceledAt),
    ),
    orderBy: desc(taskRuns.createdAt),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
    },
  });

  return activeRun ?? null;
}

async function resolveCancelableTaskRun(
  runId: number,
): Promise<CancelableTaskRunTarget | null> {
  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      canceledAt: true,
    },
  });

  if (!sourceRun) {
    return null;
  }

  if (!sourceRun.taskId) {
    return activeRunStatuses.includes(
      sourceRun.status as (typeof activeRunStatuses)[number],
    ) && sourceRun.canceledAt === null
      ? {
          id: sourceRun.id,
          taskId: sourceRun.taskId,
          status: sourceRun.status,
          sandboxServerUrl: sourceRun.sandboxServerUrl,
          actingUserId: sourceRun.actingUserId,
        }
      : null;
  }

  return findLatestActiveTaskRunForTask(sourceRun.taskId);
}

function isTerminalStopResult(
  result: Awaited<ReturnType<typeof stopTaskRun>>,
): boolean {
  return (
    result.success === false &&
    (result.statusCode === 404 || result.statusCode === 409)
  );
}

export async function handleTaskCancellation(
  payload: SlackInteractivePayload,
): Promise<void> {
  const actionValue =
    payload.actions[0]?.type === 'button'
      ? parseTaskCancellationActionValue(payload.actions[0].value)
      : null;

  if (!actionValue) {
    console.error('❌ No runId found in cancel action');
    return;
  }

  if (actionValue.slackUserId && actionValue.slackUserId !== payload.user.id) {
    console.warn(
      `[handleTaskCancellation] Ignoring cancel click for task run ${actionValue.runId} from Slack user ${payload.user.id}`,
    );
    return;
  }

  const { runId, taskId } = actionValue;

  try {
    const cancelableTaskRun = taskId
      ? await findLatestActiveTaskRunForTask(taskId)
      : runId
        ? await resolveCancelableTaskRun(runId)
        : null;

    if (!cancelableTaskRun) {
      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: true,
        blocks: buildTaskNotRunningResponseBlocks(payload.message.blocks),
      });
      return;
    }

    // Prefer the canceling Slack user's linked Roomote account for the
    // sandbox stop token when present; otherwise stopTaskRun falls back to
    // the run actor or a deployment-principal token.
    const cancelerMapping = await lookupSlackUserMapping({
      slackUserId: payload.user.id,
      teamId: payload.team.id,
    });

    const stopResult = await stopTaskRun({
      run: cancelableTaskRun,
      authUserId: cancelerMapping.activeMapping?.userId ?? null,
      allowDirectCancelWithoutSandbox: true,
      cancelledBy: {
        ...(payload.user.name ? { name: payload.user.name } : {}),
        source: 'slack',
      },
    });

    if (isTerminalStopResult(stopResult)) {
      console.log(
        `[handleTaskCancellation] Cancel target ${taskId ?? runId ?? 'unknown'} not found or already in a terminal state`,
      );

      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: true,
        blocks: buildTaskNotRunningResponseBlocks(payload.message.blocks),
      });
      return;
    }

    if (!stopResult.success) {
      throw new Error(stopResult.error || 'Failed to stop task');
    }

    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: true,
      blocks: buildTaskCancellationResponseBlocks(TASK_CANCELED_RESPONSE_TEXT),
    });

    console.log(`✅ Successfully canceled task run ${cancelableTaskRun.id}`);
  } catch (error) {
    console.error(
      `❌ Failed to cancel task run ${taskId ?? runId ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: `❌ Failed to cancel task: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}
