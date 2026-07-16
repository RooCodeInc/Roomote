import {
  ALL_REPOSITORIES,
  activeRunStatuses,
  type TaskPayload,
  type ComputeProvider,
  type LaunchCodingHarness,
  type StandardTask,
  RunStatus,
  TaskPayloadKind,
  isExitedRunStatus,
  resolveEvalHarnessSelection,
} from '@roomote/types';
import {
  type RoutingDecision,
  buildSlackRoutingContext,
  enqueueTask,
  getTaskUrl,
  routeTask,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  markTaskStartParallelCountEndedAt,
  slackInstallations,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';
import { Env, getArtifactById, getRepositories } from '@/lib/server';
import {
  resolveEnvironmentSourceControlProvider,
  resolveSingleSourceControlProvider,
} from '@/lib/server/source-control-provider';
import { humanizeFilename } from '@/lib/task-utils';

export type CreateTaskRunResult =
  | { success: true; id: number; taskId: string }
  | { success: false; error: string };

type CreateStandardTaskRunInput = {
  harness?: LaunchCodingHarness;
  model?: string;
  computeProvider?: ComputeProvider;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  sourceArtifactPath?: string;
  sourceArtifactVersion?: number;
  payload: TaskPayload<typeof TaskPayloadKind.StandardTask>;
};

function getManualTaskRepositoryFullNames(
  payload: TaskPayload<typeof TaskPayloadKind.StandardTask>,
) {
  if (payload.selectedRepositories?.length) {
    return [...new Set(payload.selectedRepositories.filter(Boolean))].sort(
      (left, right) => left.localeCompare(right),
    );
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
    if (!input.payload.environmentId && !input.payload.repo) {
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

    const selectedRepositoryFullNames = getManualTaskRepositoryFullNames(
      input.payload,
    );
    const availableRepositories =
      selectedRepositoryFullNames.length === 0
        ? []
        : await getRepositories(auth);
    const selectedRepositories = availableRepositories.filter((repository) =>
      selectedRepositoryFullNames.includes(repository.fullName),
    );
    const sourceControlProvider =
      input.payload.sourceControlProvider ??
      resolveSingleSourceControlProvider(
        selectedRepositories.map(
          (repository) => repository.sourceControlProvider,
        ),
      ) ??
      (await resolveEnvironmentSourceControlProvider(
        input.payload.environmentId,
      ));

    const task: StandardTask = {
      harness: evalSelection.harness ?? input.harness,
      computeProvider: input.computeProvider,
      type: TaskPayloadKind.StandardTask,
      payload: {
        ...input.payload,
        ...(sourceControlProvider ? { sourceControlProvider } : {}),
        ...(evalSelection.harnessModelOverrides
          ? {
              harnessModelOverrides: {
                ...(input.payload.harnessModelOverrides ?? {}),
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

      await db.transaction(async (tx) => {
        await tx
          .update(taskRuns)
          .set({ status: RunStatus.Canceled, canceledAt: endedAt })
          .where(eq(taskRuns.id, job.id));

        await markTaskStartParallelCountEndedAt(tx, {
          runId: job.id,
          endedAt,
        });
      });
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
