import {
  ALL_REPOSITORIES,
  activeRunStatuses,
  buildFastAgentChildTaskMetadata,
  getFastAgentParentFromPayload,
  type TaskPayload,
  type ComputeProvider,
  type LaunchCodingHarness,
  type StandardTask,
  type TaskGoal,
  RunStatus,
  TaskPayloadKind,
  isExitedRunStatus,
  resolveEvalHarnessSelection,
} from '@roomote/types';
import {
  type RoutingDecision,
  buildSlackRoutingContext,
  canRetryFailedStart,
  DeploymentReadOnlyError,
  enqueueTask,
  fastAgentConversationRepository,
  getTaskUrl,
  routeTask,
} from '@roomote/cloud-agents/server';
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
  sql,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { SlackNotifier, settleSlackLiveTaskCardForRun } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';
import { Env, getArtifactById, getRepositories } from '@/lib/server';
import {
  resolveEnvironmentSourceControlProvider,
  resolveSelectedRepositorySourceControlProvider,
} from '@/lib/server/source-control-provider';
import { humanizeFilename } from '@/lib/task-utils';
import { sendSandboxPromptCommand } from '../sandbox-session';
import { resolveTaskByIdAccessCommand } from '../tasks/by-id';

export type CreateTaskRunResult =
  | { success: true; id: number; taskId: string }
  | { success: false; error: string };

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

type CreateStandardTaskRunInput = {
  harness?: LaunchCodingHarness;
  model?: string;
  computeProvider?: ComputeProvider;
  failedStartSourceRunId?: number;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  sourceArtifactPath?: string;
  sourceArtifactVersion?: number;
  payload: TaskPayload<typeof TaskPayloadKind.StandardTask>;
};

function stripClientFastAgentLinkage(
  payload: TaskPayload<typeof TaskPayloadKind.StandardTask>,
): TaskPayload<typeof TaskPayloadKind.StandardTask> {
  const sanitized = { ...payload };
  delete sanitized.fastAgentParent;
  delete sanitized.fastAgentSessionId;
  delete sanitized.communicationContextInherited;
  return sanitized;
}

function getFailedStartReplacementKey(sourceRunId: number): string {
  return `failed-start-replacement:${sourceRunId}`;
}

async function findFailedStartReplacement(
  launchIdempotencyKey: string,
): Promise<CreateTaskRunResult | null> {
  const existing = await db.query.taskRuns.findFirst({
    where: sql`${taskRuns.payload}->>'launchIdempotencyKey' = ${launchIdempotencyKey}`,
    columns: { id: true, taskId: true },
  });

  return existing
    ? { success: true, id: existing.id, taskId: existing.taskId }
    : null;
}

async function resolveFailedStartFastAgentMetadata({
  auth,
  sourceRunId,
}: {
  auth: UserAuthSuccess;
  sourceRunId?: number;
}): Promise<ReturnType<typeof buildFastAgentChildTaskMetadata> | null> {
  if (sourceRunId === undefined) {
    return null;
  }

  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, sourceRunId),
    columns: {
      taskId: true,
      status: true,
      payloadKind: true,
      payload: true,
      error: true,
      result: true,
    },
  });

  if (
    !sourceRun ||
    sourceRun.payloadKind !== TaskPayloadKind.StandardTask ||
    sourceRun.status !== RunStatus.Failed
  ) {
    throw new Error('Failed task start not found.');
  }

  const sourceTaskAccess = await resolveTaskByIdAccessCommand(auth, {
    taskId: sourceRun.taskId,
  });
  if (sourceTaskAccess.kind !== 'resolved') {
    throw new Error('Failed task start not found.');
  }

  const parent = getFastAgentParentFromPayload(sourceRun.payload);
  if (!parent) {
    return null;
  }

  const session = await fastAgentConversationRepository.findById({
    id: parent.sessionId,
    fallbackConversation: parent.conversation,
  });
  if (!session || session.userId !== auth.userId) {
    throw new Error('Failed task start is not linked to your Fast session.');
  }

  return buildFastAgentChildTaskMetadata({
    sessionId: session.id,
    conversation: session.conversation,
  });
}

export async function createFailedStartReplacementTaskRunCommand(
  auth: UserAuthSuccess,
  input: { runId: number },
): Promise<CreateTaskRunResult> {
  try {
    const sourceRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.runId),
    });
    if (
      !sourceRun ||
      sourceRun.payloadKind !== TaskPayloadKind.StandardTask ||
      !(await canRetryFailedStart(sourceRun))
    ) {
      return { success: false, error: 'Failed task start not found.' };
    }

    const sourceTaskAccess = await resolveTaskByIdAccessCommand(auth, {
      taskId: sourceRun.taskId,
    });
    if (sourceTaskAccess.kind !== 'resolved') {
      return { success: false, error: 'Failed task start not found.' };
    }
    if (!sourceTaskAccess.task.model) {
      return { success: false, error: 'Failed task model not found.' };
    }

    const payload = { ...sourceRun.payload };
    delete payload.communicationSourceEventId;
    const launchIdempotencyKey = getFailedStartReplacementKey(sourceRun.id);
    payload.launchIdempotencyKey = launchIdempotencyKey;

    const existingReplacement =
      await findFailedStartReplacement(launchIdempotencyKey);
    if (existingReplacement) {
      return existingReplacement;
    }

    const result = await createStandardTaskRunCommand(auth, {
      harness: sourceRun.harness,
      model: sourceTaskAccess.task.model,
      computeProvider: sourceRun.vendor ?? undefined,
      failedStartSourceRunId: sourceRun.id,
      payload,
    });

    if (result.success) {
      return result;
    }

    return (await findFailedStartReplacement(launchIdempotencyKey)) ?? result;
  } catch (error) {
    console.error(error);
    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
}

function getManualTaskRepositoryFullNames(
  payload: TaskPayload<typeof TaskPayloadKind.StandardTask>,
) {
  if (payload.selectedRepositories?.length) {
    return [...new Set(payload.selectedRepositories.filter(Boolean))];
  }

  if (payload.repo && payload.repo !== ALL_REPOSITORIES) {
    return [payload.repo];
  }

  return [];
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
    sourceTaskId: sourceArtifact.taskId,
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

async function notifySourceTaskArtifactBuild({
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

export async function routeHomeTaskCommand(
  auth: UserAuthSuccess,
  input: {
    description: string;
    images?: string[];
  },
): Promise<RoutingDecision> {
  try {
    const trimmedDescription = input.description.trim();

    if (trimmedDescription.length === 0) {
      return {
        status: 'fallback',
        reason: 'Task description is required for auto routing.',
      };
    }

    const routingContext = await buildSlackRoutingContext({
      userId: auth.userId,
      taskDescription: trimmedDescription,
      ...(input.images?.length ? { images: input.images } : {}),
      apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
    });

    return await routeTask(routingContext);
  } catch (error) {
    console.error(error);

    return {
      status: 'fallback',
      reason:
        error instanceof Error ? error.message : 'An unknown error occurred.',
    };
  }
}

export async function createStandardTaskRunCommand(
  auth: UserAuthSuccess,
  input: CreateStandardTaskRunInput,
): Promise<CreateTaskRunResult> {
  try {
    const payload = stripClientFastAgentLinkage(input.payload);

    if (!payload.environmentId && !payload.repo) {
      return {
        success: false,
        error: 'Select an environment before starting a task.',
      };
    }

    const evalSelection = resolveEvalHarnessSelection({
      harness: input.harness,
      model: input.model,
    });

    if (!evalSelection.ok) {
      throw new Error(evalSelection.error);
    }

    const selectedRepositoryFullNames =
      getManualTaskRepositoryFullNames(payload);
    const availableRepositories =
      selectedRepositoryFullNames.length === 0
        ? []
        : await getRepositories(auth);
    const selectedRepositories = availableRepositories.filter((repository) =>
      selectedRepositoryFullNames.includes(repository.fullName),
    );
    const sourceControlProvider =
      payload.sourceControlProvider ??
      resolveSelectedRepositorySourceControlProvider(
        selectedRepositories,
        selectedRepositoryFullNames,
      ) ??
      (await resolveEnvironmentSourceControlProvider(payload.environmentId));
    const fastAgentMetadata = await resolveFailedStartFastAgentMetadata({
      auth,
      sourceRunId: input.failedStartSourceRunId,
    });

    const task: StandardTask = {
      harness: evalSelection.harness ?? input.harness,
      computeProvider: input.computeProvider,
      type: TaskPayloadKind.StandardTask,
      payload: {
        ...payload,
        ...(fastAgentMetadata ?? {}),
        ...(sourceControlProvider ? { sourceControlProvider } : {}),
        ...(evalSelection.harnessModelOverrides
          ? {
              harnessModelOverrides: {
                ...(payload.harnessModelOverrides ?? {}),
                ...evalSelection.harnessModelOverrides,
              },
            }
          : {}),
      },
    };

    const launchResult = await enqueueTask({
      task,
      initiator: { kind: 'user', userId: auth.userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    try {
      await notifySourceTaskArtifactBuild({
        auth,
        sourceTaskId: input.sourceTaskId,
        sourceArtifactId: input.sourceArtifactId,
        sourceArtifactPath: input.sourceArtifactPath,
        sourceArtifactVersion: input.sourceArtifactVersion,
        newTaskId: 'taskId' in launchResult ? launchResult.taskId : undefined,
      });
    } catch (error) {
      console.error(
        `[createStandardTaskRun] Failed to notify Slack threads for source task ${input.sourceTaskId ?? 'unknown'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      success: true,
      id: launchResult.id,
      taskId: launchResult.taskId,
    };
  } catch (error) {
    console.error(error);

    if (error instanceof DeploymentReadOnlyError) {
      return { success: false, error: error.code };
    }

    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
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
