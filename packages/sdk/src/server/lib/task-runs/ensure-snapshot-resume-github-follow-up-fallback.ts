import { enqueueTask } from '@roomote/cloud-agents/server';
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

function getDeferredResumePromptFallbackRunId(result: unknown): number | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const fallbackRunId = (result as Record<string, unknown>)
    .deferredResumePromptFallbackRunId;

  return typeof fallbackRunId === 'number' ? fallbackRunId : null;
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
  resumeRunId,
}: {
  resumeRunId: number;
}): Promise<{ id: number; taskId: string | null } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${resumeRunId})`);

    const resumeRun = await tx.query.taskRuns.findFirst({
      where: eq(taskRuns.id, resumeRunId),
      columns: {
        id: true,
        payloadKind: true,
        payload: true,
        result: true,
      },
    });

    if (
      !resumeRun ||
      resumeRun.payloadKind !== TaskPayloadKind.SnapshotResume
    ) {
      return null;
    }

    if (getDeferredResumePromptAccepted(resumeRun.result) === true) {
      return null;
    }

    const existingFallbackRunId = getDeferredResumePromptFallbackRunId(
      resumeRun.result,
    );

    if (existingFallbackRunId) {
      const existingFallbackRun = await tx.query.taskRuns.findFirst({
        where: eq(taskRuns.id, existingFallbackRunId),
        columns: { id: true, taskId: true },
      });

      return existingFallbackRun
        ? {
            id: existingFallbackRun.id,
            taskId: existingFallbackRun.taskId ?? null,
          }
        : { id: existingFallbackRunId, taskId: null };
    }

    const fallbackTask = getResumePromptFallbackTask(resumeRun.payload);

    if (!fallbackTask) {
      return null;
    }

    const initiator = resolveFallbackInitiator(fallbackTask);

    if (!initiator) {
      console.warn(
        `[ensureSnapshotResumeGitHubFollowUpFallback] Skipping fallback launch for resume run ${resumeRunId}: fallback task carries no user or GitHub identity.`,
      );
      return null;
    }

    const fallbackPayload = fallbackTask.payload as TaskPayload<
      typeof TaskPayloadKind.GithubPrReviewFollowUp
    >;

    const fallbackLaunch = await enqueueTask({
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
      resumeRun.result &&
      typeof resumeRun.result === 'object' &&
      !Array.isArray(resumeRun.result)
        ? (resumeRun.result as Record<string, unknown>)
        : {};

    await tx
      .update(taskRuns)
      .set({
        result: {
          ...latestResult,
          deferredResumePromptFallbackRunId: fallbackLaunch.id,
          deferredResumePromptFallbackEnqueuedAt: new Date().toISOString(),
        },
      })
      .where(eq(taskRuns.id, resumeRunId));

    return { id: fallbackLaunch.id, taskId: fallbackLaunch.taskId };
  });
}
