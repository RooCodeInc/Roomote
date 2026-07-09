import {
  buildTaskCancellationResponseBlocks,
  buildTaskNotRunningResponseBlocks,
  parseTaskCancellationActionValue,
  postSlackInteractiveResponse,
  TASK_CANCELED_RESPONSE_TEXT,
  type SlackInteractivePayload,
} from '@roomote/slack';
import { activeCloudTaskStatuses } from '@roomote/types';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  taskRuns,
} from '@roomote/db/server';

import { stopTaskJob } from '../../tasks/task-stop.js';

type CancelableCloudJobTarget = Parameters<typeof stopTaskJob>[0]['job'] & {
  taskId: string | null;
};

async function findLatestActiveCloudJobForTask(
  taskId: string,
): Promise<CancelableCloudJobTarget | null> {
  const activeJob = await db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.taskId, taskId),
      inArray(taskRuns.status, [...activeCloudTaskStatuses]),
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

  return activeJob ?? null;
}

async function resolveCancelableCloudJob(
  cloudJobId: number,
): Promise<CancelableCloudJobTarget | null> {
  const sourceJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, cloudJobId),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      canceledAt: true,
    },
  });

  if (!sourceJob) {
    return null;
  }

  if (!sourceJob.taskId) {
    return activeCloudTaskStatuses.includes(
      sourceJob.status as (typeof activeCloudTaskStatuses)[number],
    ) && sourceJob.canceledAt === null
      ? {
          id: sourceJob.id,
          taskId: sourceJob.taskId,
          status: sourceJob.status,
          sandboxServerUrl: sourceJob.sandboxServerUrl,
          actingUserId: sourceJob.actingUserId,
        }
      : null;
  }

  return findLatestActiveCloudJobForTask(sourceJob.taskId);
}

function isTerminalStopResult(
  result: Awaited<ReturnType<typeof stopTaskJob>>,
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
    console.error('❌ No cloudJobId found in cancel action');
    return;
  }

  if (actionValue.slackUserId && actionValue.slackUserId !== payload.user.id) {
    console.warn(
      `[handleTaskCancellation] Ignoring cancel click for cloud job ${actionValue.cloudJobId} from Slack user ${payload.user.id}`,
    );
    return;
  }

  const { cloudJobId, taskId } = actionValue;

  try {
    const cancelableCloudJob = taskId
      ? await findLatestActiveCloudJobForTask(taskId)
      : cloudJobId
        ? await resolveCancelableCloudJob(cloudJobId)
        : null;

    if (!cancelableCloudJob) {
      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: true,
        blocks: buildTaskNotRunningResponseBlocks(payload.message.blocks),
      });
      return;
    }

    const stopResult = await stopTaskJob({
      job: cancelableCloudJob,
      allowDirectCancelWithoutSandbox: true,
    });

    if (isTerminalStopResult(stopResult)) {
      console.log(
        `[handleTaskCancellation] Cancel target ${taskId ?? cloudJobId ?? 'unknown'} not found or already in a terminal state`,
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

    console.log(`✅ Successfully canceled cloud job ${cancelableCloudJob.id}`);
  } catch (error) {
    console.error(
      `❌ Failed to cancel job ${taskId ?? cloudJobId ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: `❌ Failed to cancel task: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}
