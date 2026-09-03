import {
  activeRunStatuses,
  type TaskGoal,
  RunStatus,
  isExitedRunStatus,
} from '@roomote/types';
import { getTaskUrl } from '@roomote/cloud-agents/server';
import { captureTaskSettled } from '@roomote/telemetry/server';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  markTaskStartParallelCountEndedAt,
  prepareTaskGoalActivation,
  slackInstallations,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { SlackNotifier, settleSlackLiveTaskCardForRun } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';
import { getArtifactById } from '@/lib/server';
import { humanizeFilename } from '@/lib/task-utils';
import { sendSandboxPromptCommand } from '../sandbox-session';
import { resolveTaskByIdAccessCommand } from '../tasks/by-id';

export async function startTaskGoalCommand(
  auth: UserAuthSuccess,
  input: {
    taskId: string;
    goal: { objective: string; maxContinuations: number };
    clientMessageId?: string;
    userImageUrl?: string;
  },
): Promise<
  { success: true; goal: TaskGoal } | { success: false; error: string }
> {
  const taskAccess = await resolveTaskByIdAccessCommand(auth, {
    taskId: input.taskId,
  });

  if (taskAccess.kind !== 'resolved') {
    return { success: false, error: 'Task not found' };
  }

  const activation = await prepareTaskGoalActivation({
    taskId: input.taskId,
    goal: input.goal,
  });
  if (!activation) {
    return { success: false, error: 'Goal Mode activation is already pending' };
  }

  try {
    await sendSandboxPromptCommand(
      auth,
      {
        taskId: input.taskId,
        prompt: input.goal.objective,
        source: 'web',
        clientMessageId: input.clientMessageId,
        userImageUrl: input.userImageUrl,
        autoSteerWhenQueued: true,
      },
      {
        goalContext: {
          ...input.goal,
          generation: activation.generation,
          status: 'active',
          continuationsUsed: 0,
          blockedReason: null,
          completedAt: null,
        },
      },
    );
  } catch (error) {
    try {
      await activation.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back Goal Mode activation:', rollbackError);
    }
    throw error;
  }

  const goal = await activation.commit();
  if (!goal) {
    await activation.rollback();
    return { success: false, error: 'Goal Mode activation was superseded' };
  }

  return { success: true, goal };
}

function getSlackChannelFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const channel =
    typeof record.channel === 'string'
      ? record.channel
      : typeof record.slackChannel === 'string'
        ? record.slackChannel
        : undefined;

  return channel;
}

async function getValidatedArtifactBuildSource({
  auth,
  sourceTaskId,
  sourceArtifactId,
  sourceArtifactPath,
  sourceArtifactVersion,
}: {
  auth: UserAuthSuccess;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  sourceArtifactPath?: string;
  sourceArtifactVersion?: number;
}): Promise<{
  sourceTaskId: string;
  artifactPath: string;
  artifactVersion: number;
} | null> {
  if (!sourceTaskId) {
    return null;
  }

  if (!sourceArtifactId) {
    console.warn(
      `[artifactBuildSource] Missing source artifact ID for source task ${sourceTaskId}, skipping artifact-build Slack notification`,
    );
    return null;
  }

  const sourceArtifact = await getArtifactById({
    taskId: sourceTaskId,
    artifactId: sourceArtifactId,
    auth: {
      userId: auth.userId,
      isAdmin: auth.isAdmin,
    },
  });

  if (!sourceArtifact) {
    console.warn(
      `[artifactBuildSource] Could not validate source artifact ${sourceArtifactId} for source task ${sourceTaskId}, skipping artifact-build Slack notification`,
    );
    return null;
  }

  if (sourceArtifactPath && sourceArtifact.path !== sourceArtifactPath) {
    console.warn(
      `[artifactBuildSource] Source artifact path mismatch for task ${sourceTaskId}: expected ${sourceArtifact.path}, received ${sourceArtifactPath}, skipping artifact-build Slack notification`,
    );
    return null;
  }

  if (
    sourceArtifactVersion !== undefined &&
    sourceArtifact.version !== sourceArtifactVersion
  ) {
    console.warn(
      `[artifactBuildSource] Source artifact version mismatch for task ${sourceTaskId}: expected ${sourceArtifact.version}, received ${sourceArtifactVersion}, skipping artifact-build Slack notification`,
    );
    return null;
  }

  return {
    sourceTaskId: sourceArtifact.taskId!,
    artifactPath: sourceArtifact.path,
    artifactVersion: sourceArtifact.version,
  };
}

async function notifySlackThreadsAboutArtifactBuild({
  sourceTaskId,
  newTaskId,
  artifactPath,
  artifactVersion,
}: {
  sourceTaskId?: string;
  newTaskId?: string;
  artifactPath?: string;
  artifactVersion?: number;
}): Promise<void> {
  if (!sourceTaskId || !newTaskId) {
    return;
  }

  // Slack channel bindings live on the tasks row.
  const sourceTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, sourceTaskId),
    columns: {
      slackChannelId: true,
      slackThreadTs: true,
    },
  });

  const threadTs = sourceTask?.slackThreadTs;

  if (!threadTs) {
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true },
  });

  if (!slackInstallation) {
    console.warn(
      '[notifyArtifactBuildSlackThreads] No active Slack installation, skipping artifact-build Slack notification',
    );
    return;
  }

  let channel = sourceTask.slackChannelId ?? undefined;

  if (!channel) {
    // Fall back to channel metadata stored on run payloads for tasks created
    // before channel bindings were stamped onto the tasks row.
    const sourceRuns = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, sourceTaskId),
      columns: { payload: true },
    });

    channel = sourceRuns
      .map((run) => getSlackChannelFromPayload(run.payload))
      .find(Boolean);
  }

  if (!channel) {
    console.warn(
      `[notifyArtifactBuildSlackThreads] No Slack channel found for source task ${sourceTaskId} thread ${threadTs}, skipping artifact-build Slack notification`,
    );
    return;
  }

  const notifier = new SlackNotifier(slackInstallation.botAccessToken);
  const taskUrl = getTaskUrl({
    taskId: newTaskId,
    utm: { source: 'slack', campaign: 'artifact_build' },
  });
  const artifactLabel = artifactPath
    ? `${humanizeFilename(artifactPath)}${
        artifactVersion !== undefined ? ` (v${artifactVersion})` : ''
      }`
    : 'this artifact';
  const text = `Started a new task to build ${artifactLabel}. <${taskUrl}|Open task>`;
  const blocks = [
    {
      type: 'section' as const,
      text: {
        type: 'mrkdwn' as const,
        text,
      },
    },
  ];

  try {
    await notifier.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(
      `[notifyArtifactBuildSlackThreads] Failed to notify Slack thread ${threadTs} about artifact build task ${newTaskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function notifySourceTaskArtifactBuild({
  auth,
  sourceTaskId,
  sourceArtifactId,
  sourceArtifactPath,
  sourceArtifactVersion,
  newTaskId,
}: {
  auth: UserAuthSuccess;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  sourceArtifactPath?: string;
  sourceArtifactVersion?: number;
  newTaskId?: string;
}): Promise<void> {
  const source = await getValidatedArtifactBuildSource({
    auth,
    sourceTaskId,
    sourceArtifactId,
    sourceArtifactPath,
    sourceArtifactVersion,
  });

  if (!source) {
    return;
  }

  await notifySlackThreadsAboutArtifactBuild({
    sourceTaskId: source.sourceTaskId,
    newTaskId,
    artifactPath: source.artifactPath,
    artifactVersion: source.artifactVersion,
  });
}

export async function cancelTaskRunCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; runId?: number },
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const taskFilter = eq(taskRuns.taskId, input.taskId);

    const job =
      // Snapshot resumes reuse taskId, so a stale runId can still point at
      // an older non-terminal row. Always prefer the newest active run for the
      // task over the supplied ID.
      (await db.query.taskRuns.findFirst({
        where: and(
          taskFilter,
          inArray(taskRuns.status, [...activeRunStatuses]),
        ),
        orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
      })) ??
      (input.runId !== undefined
        ? await db.query.taskRuns.findFirst({
            where: and(eq(taskRuns.id, input.runId), taskFilter),
            orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
          })
        : null) ??
      (await db.query.taskRuns.findFirst({
        where: taskFilter,
        orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
      }));

    if (!job) {
      return { success: false, error: 'Task run not found' };
    }

    if (!isExitedRunStatus(job.status)) {
      const endedAt = new Date();

      const canceledRun = await db.transaction(async (tx) => {
        const [canceled] = await tx
          .update(taskRuns)
          .set({ status: RunStatus.Canceled, canceledAt: endedAt })
          .where(
            and(
              eq(taskRuns.id, job.id),
              inArray(taskRuns.status, [...activeRunStatuses]),
            ),
          )
          .returning({ id: taskRuns.id });

        if (!canceled) {
          return null;
        }

        await markTaskStartParallelCountEndedAt(tx, {
          runId: job.id,
          endedAt,
        });

        return canceled;
      });

      if (canceledRun) {
        void captureTaskSettled(canceledRun.id, 'canceled');
        // A run canceled before any worker claimed it has nobody else to
        // settle its Slack task card.
        void settleSlackLiveTaskCardForRun({
          taskId: job.taskId,
          payload: job.payload,
          status: RunStatus.Canceled,
        });
      }
    }

    return { success: true };
  } catch (error) {
    console.error(error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

export { retryFailedTaskStartCommand } from './retry-failed-start';
