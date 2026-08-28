import { Job } from 'bullmq';

import {
  buildGitHubPrSynchronizeFollowUpMessage,
  enqueueTask,
  SnapshotResumeAlreadyExistsError,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  getTaskGoalForRun,
  repositories,
  sql,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import {
  acquireGithubPrReviewLifecycleLock,
  activePrReviewFollowUpRequestSchema,
  reconcileGithubPrReviewCheckForRun,
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
  launch: (launchIdempotencyKey: string) => Promise<{ id: number }>,
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
    const repositoryId = data.fallback.prLinkage.repositoryId;
    const installationId =
      data.installationId ??
      (repositoryId
        ? (
            await db.query.repositories.findFirst({
              where: eq(repositories.id, repositoryId),
              columns: { id: true },
              with: {
                githubInstallation: { columns: { installationId: true } },
              },
            })
          )?.githubInstallation?.installationId
        : undefined);
    if (!installationId) {
      throw new Error(
        `Could not resolve GitHub installation for PR review fallback ${data.repository}#${data.prNumber}`,
      );
    }

    const launchIdempotencyKey = [
      'github-pr-review-fallback',
      data.taskId,
      data.runId,
      data.eventHeadSha,
    ].join(':');
    const existingFallback = await db.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.taskId, data.taskId),
        sql`${taskRuns.payload}->>'launchIdempotencyKey' = ${launchIdempotencyKey}`,
      ),
      columns: { id: true },
    });
    const fallbackRun =
      existingFallback ?? (await launch(launchIdempotencyKey));
    releaseLifecycleLock.signal.throwIfAborted();

    await transferGithubPrReviewCheckToRun({
      installationId,
      repository: data.repository,
      prNumber: data.prNumber,
      taskId: data.taskId,
      previousRunId: data.runId,
      newRunId: fallbackRun.id,
      signal: releaseLifecycleLock.signal,
    });
    await reconcileGithubPrReviewCheckForRun({
      installationId,
      repository: data.repository,
      prNumber: data.prNumber,
      taskId: data.taskId,
      runId: fallbackRun.id,
      signal: releaseLifecycleLock.signal,
    });

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

    await launchFallbackWithCheckTransfer(
      data,
      async (launchIdempotencyKey) => {
        try {
          return await enqueueTask({
            task: {
              type: TaskPayloadKind.SnapshotResume,
              sourceSnapshotId: run.snapshotId!,
              sourceRunId: run.id,
              payload: { ...resumePayload, launchIdempotencyKey },
            },
            actingUserId: run.actingUserId,
          });
        } catch (error) {
          if (error instanceof SnapshotResumeAlreadyExistsError) {
            return { id: error.existingRunId };
          }
          throw error;
        }
      },
    );
    return;
  }

  await launchFallbackWithCheckTransfer(data, (launchIdempotencyKey) =>
    enqueueTask({
      existingTaskId: run.taskId,
      task: {
        ...data.fallback.task,
        payload: {
          ...data.fallback.task.payload,
          launchIdempotencyKey,
        },
      },
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
