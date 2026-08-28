import { Job } from 'bullmq';

import {
  buildGitHubPrSynchronizeFollowUpMessage,
  enqueueTask,
} from '@roomote/cloud-agents/server';
import {
  db,
  eq,
  getTaskGoalForRun,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import {
  acquireGithubPrReviewLifecycleLock,
  activePrReviewFollowUpRequestSchema,
  type ActivePrReviewFollowUpRequest,
  transferGithubPrReviewCheckToRun,
  withSandboxServerRpcClient,
} from '@roomote/sdk/server';
import {
  isExitedRunStatus,
  isSnapshotResumable,
  type TaskPayload,
  TaskPayloadKind,
} from '@roomote/types';

type ActivePrReviewFollowUpJob = Job<
  ActivePrReviewFollowUpRequest,
  void,
  string
>;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildClientMessageId(data: ActivePrReviewFollowUpRequest): string {
  return `github-pr-synchronize:${data.runId}:${data.repository}:${data.prNumber}`;
}

async function updateLinkedHead(
  taskId: string,
  headSha: string,
): Promise<void> {
  await db
    .update(taskPullRequests)
    .set({ prSha: headSha })
    .where(eq(taskPullRequests.taskId, taskId));
}

async function launchFallbackWithCheckTransfer(
  data: ActivePrReviewFollowUpRequest,
  launch: () => Promise<{ id: number }>,
): Promise<void> {
  const releaseLifecycleLock = await acquireGithubPrReviewLifecycleLock(
    data.repository,
    data.prNumber,
  );
  if (!releaseLifecycleLock) {
    throw new Error(
      `Timed out serializing PR review fallback for ${data.repository}#${data.prNumber}`,
    );
  }

  try {
    releaseLifecycleLock.signal.throwIfAborted();
    const fallbackRun = await launch();
    releaseLifecycleLock.signal.throwIfAborted();

    if (data.installationId) {
      await transferGithubPrReviewCheckToRun({
        installationId: data.installationId,
        repository: data.repository,
        prNumber: data.prNumber,
        taskId: data.taskId,
        previousRunId: data.runId,
        newRunId: fallbackRun.id,
        signal: releaseLifecycleLock.signal,
      });
    }

    await updateLinkedHead(data.taskId, data.eventHeadSha);
  } finally {
    await releaseLifecycleLock();
  }
}

export const activePrReviewFollowUpJob = async (
  job: ActivePrReviewFollowUpJob,
): Promise<void> => {
  const data = activePrReviewFollowUpRequestSchema.parse(job.data);
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, data.runId),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      snapshotId: true,
      snapshotCreatedAt: true,
      port: true,
      payload: true,
      actingUserId: true,
    },
  });

  if (!run || run.taskId !== data.taskId) {
    console.warn(
      `[ActivePrReviewFollowUp] Review run ${data.runId} was not found, skipping`,
    );
    return;
  }

  const prompt = buildGitHubPrSynchronizeFollowUpMessage({
    repository: data.repository,
    prNumber: data.prNumber,
    previousHeadSha: data.previousHeadSha,
    eventHeadSha: data.eventHeadSha,
  });

  if (!isExitedRunStatus(run.status)) {
    const goal = await getTaskGoalForRun(run.id);
    await withSandboxServerRpcClient({
      runId: run.id,
      userId: null,
      sandboxServerUrl: run.sandboxServerUrl ?? data.sandboxServerUrl,
      call: (client) =>
        client.commands.sendPrompt.mutate({
          prompt,
          source: 'github-pr-synchronize',
          clientMessageId: buildClientMessageId(data),
          visibleInTranscript: false,
          ...(goal?.status === 'active' ? { goalContext: goal } : {}),
        }),
    });
    await updateLinkedHead(run.taskId, data.eventHeadSha);
    return;
  }

  if (run.snapshotId && isSnapshotResumable(run.snapshotCreatedAt)) {
    const sourcePayload = (run.payload ?? {}) as Record<string, unknown>;
    const selectedRepositories = Array.isArray(
      sourcePayload.selectedRepositories,
    )
      ? sourcePayload.selectedRepositories.filter(
          (value): value is string => typeof value === 'string',
        )
      : undefined;
    const resumePayload = {
      repo: optionalString(sourcePayload.repo) ?? data.repository,
      environmentId: optionalString(sourcePayload.environmentId),
      port: run.port ?? undefined,
      sourceSnapshotId: run.snapshotId,
      sourceRunId: run.id,
      ...(selectedRepositories ? { selectedRepositories } : {}),
      resumePrompt: prompt,
      resumePromptSource: 'github-pr-synchronize',
      resumePromptClientMessageId: buildClientMessageId(data),
    } satisfies TaskPayload<typeof TaskPayloadKind.SnapshotResume>;

    await launchFallbackWithCheckTransfer(data, () =>
      enqueueTask({
        task: {
          type: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: run.snapshotId!,
          sourceRunId: run.id,
          payload: resumePayload,
        },
        actingUserId: run.actingUserId,
      }),
    );
    return;
  }

  await launchFallbackWithCheckTransfer(data, () =>
    enqueueTask({
      existingTaskId: run.taskId,
      task: data.fallback.task,
      initiator: {
        kind: 'automation',
        key: 'review_code',
        actor: data.fallback.initiatorActor,
      },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: data.fallback.prLinkage,
    }),
  );
};
