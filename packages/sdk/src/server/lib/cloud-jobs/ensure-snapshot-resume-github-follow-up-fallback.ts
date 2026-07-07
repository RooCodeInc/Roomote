import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { cloudJobs, db, eq, sql } from '@roomote/db/server';
import {
  CloudTaskType,
  type CloudTaskPayload,
  type SnapshotResumePromptFallbackTask,
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

export async function ensureSnapshotResumeGitHubFollowUpFallback({
  resumeJobId,
}: {
  resumeJobId: number;
}): Promise<{ id: number; taskId: string | null } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${resumeJobId})`);

    const resumeJob = await tx.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, resumeJobId),
      columns: {
        id: true,
        type: true,
        payload: true,
        result: true,
      },
    });

    if (!resumeJob || resumeJob.type !== CloudTaskType.SnapshotResume) {
      return null;
    }

    if (getDeferredResumePromptAccepted(resumeJob.result) === true) {
      return null;
    }

    const existingFallbackJobId = getDeferredResumePromptFallbackJobId(
      resumeJob.result,
    );

    if (existingFallbackJobId) {
      const existingFallbackJob = await tx.query.cloudJobs.findFirst({
        where: eq(cloudJobs.id, existingFallbackJobId),
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

    const fallbackLaunch = await enqueueCloudTask({
      type: CloudTaskType.GithubPrReviewFollowUp,
      payload:
        fallbackTask.payload as CloudTaskPayload<CloudTaskType.GithubPrReviewFollowUp>,
      userId: fallbackTask.userId,
      githubLogin: fallbackTask.githubLogin,
      githubUserId: fallbackTask.githubUserId,
    });

    const latestResult =
      resumeJob.result &&
      typeof resumeJob.result === 'object' &&
      !Array.isArray(resumeJob.result)
        ? (resumeJob.result as Record<string, unknown>)
        : {};

    await tx
      .update(cloudJobs)
      .set({
        result: {
          ...latestResult,
          deferredResumePromptFallbackJobId: fallbackLaunch.id,
          deferredResumePromptFallbackEnqueuedAt: new Date().toISOString(),
        },
      })
      .where(eq(cloudJobs.id, resumeJobId));

    return { id: fallbackLaunch.id, taskId: fallbackLaunch.taskId };
  });
}
