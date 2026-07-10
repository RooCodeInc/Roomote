import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { db, eq, sql, taskRuns } from '@roomote/db/server';
import {
  TaskPayloadKind,
  type TaskPayload,
  type SnapshotResumePromptFallbackTask,
  type TaskInitiator,
} from '@roomote/types';

function getDeferredResumePromptAccepted(result: unknown): boolean | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const accepted = (result as Record<string, unknown>)
    .deferredResumePromptAccepted;

  return typeof accepted === 'boolean' ? accepted : null;
}

function getDeferredResumePromptFallbackJobId(result: unknown): number | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const fallbackJobId = (result as Record<string, unknown>)
    .deferredResumePromptFallbackJobId;

  return typeof fallbackJobId === 'number' ? fallbackJobId : null;
}

function getResumePromptFallbackTask(
  payload: unknown,
): SnapshotResumePromptFallbackTask | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const fallbackTask = (payload as Record<string, unknown>)
    .resumePromptFallbackTask;

  if (
    !fallbackTask ||
    typeof fallbackTask !== 'object' ||
    Array.isArray(fallbackTask)
  ) {
    return null;
  }

  return fallbackTask as SnapshotResumePromptFallbackTask;
}

/**
 * The fallback launch is a human PR-mention follow-up. Prefer the linked user
 * when the fallback task captured one; otherwise carry the raw GitHub actor
 * identity as an external user initiator.
 */
function resolveFallbackInitiator(
  fallbackTask: SnapshotResumePromptFallbackTask,
): TaskInitiator | null {
  if (fallbackTask.userId) {
    return { kind: 'user', userId: fallbackTask.userId };
  }

  const externalId =
    fallbackTask.githubUserId != null
      ? String(fallbackTask.githubUserId)
      : (fallbackTask.githubLogin ?? null);

  if (!externalId) {
    return null;
  }

  return {
    kind: 'user',
    externalId,
    displayName: fallbackTask.githubLogin ?? undefined,
  };
}

export async function ensureSnapshotResumeGitHubFollowUpFallback({
  resumeJobId,
}: {
  resumeJobId: number;
}): Promise<{ id: number; taskId: string | null } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${resumeJobId})`);

    const resumeJob = await tx.query.taskRuns.findFirst({
      where: eq(taskRuns.id, resumeJobId),
      columns: {
        id: true,
        payloadKind: true,
        payload: true,
        result: true,
      },
    });

    if (
      !resumeJob ||
      resumeJob.payloadKind !== TaskPayloadKind.SnapshotResume
    ) {
      return null;
    }

    if (getDeferredResumePromptAccepted(resumeJob.result) === true) {
      return null;
    }

    const existingFallbackJobId = getDeferredResumePromptFallbackJobId(
      resumeJob.result,
    );

    if (existingFallbackJobId) {
      const existingFallbackJob = await tx.query.taskRuns.findFirst({
        where: eq(taskRuns.id, existingFallbackJobId),
        columns: { id: true, taskId: true },
      });

      return existingFallbackJob
        ? {
            id: existingFallbackJob.id,
            taskId: existingFallbackJob.taskId ?? null,
          }
        : { id: existingFallbackJobId, taskId: null };
    }

    const fallbackTask = getResumePromptFallbackTask(resumeJob.payload);

    if (!fallbackTask) {
      return null;
    }

    const initiator = resolveFallbackInitiator(fallbackTask);

    if (!initiator) {
      console.warn(
        `[ensureSnapshotResumeGitHubFollowUpFallback] Skipping fallback launch for resume run ${resumeJobId}: fallback task carries no user or GitHub identity.`,
      );
      return null;
    }

    const fallbackPayload = fallbackTask.payload as TaskPayload<
      typeof TaskPayloadKind.GithubPrReviewFollowUp
    >;

    const fallbackLaunch = await enqueueCloudTask({
      task: {
        type: TaskPayloadKind.GithubPrReviewFollowUp,
        payload: fallbackPayload,
        githubLogin: fallbackTask.githubLogin,
        githubUserId: fallbackTask.githubUserId,
      },
      initiator,
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'message',
      prLinkage: {
        provider: 'github',
        host: 'github.com',
        repository: fallbackPayload.repo,
        prNumber: fallbackPayload.prNumber,
        prUrl: `https://github.com/${fallbackPayload.repo}/pull/${fallbackPayload.prNumber}`,
        prTitle: fallbackPayload.prTitle,
      },
    });

    const latestResult =
      resumeJob.result &&
      typeof resumeJob.result === 'object' &&
      !Array.isArray(resumeJob.result)
        ? (resumeJob.result as Record<string, unknown>)
        : {};

    await tx
      .update(taskRuns)
      .set({
        result: {
          ...latestResult,
          deferredResumePromptFallbackJobId: fallbackLaunch.id,
          deferredResumePromptFallbackEnqueuedAt: new Date().toISOString(),
        },
      })
      .where(eq(taskRuns.id, resumeJobId));

    return { id: fallbackLaunch.id, taskId: fallbackLaunch.taskId };
  });
}
