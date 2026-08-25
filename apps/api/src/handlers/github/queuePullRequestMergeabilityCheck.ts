import {
  listTrackedPullRequestsForMergeability,
  updateTrackedPullRequestBaseRef,
} from '@roomote/db/server';
import { isRepoSkipped } from '@roomote/github';
import { enqueuePullRequestMergeabilityCheck } from '@roomote/sdk/server';

type PushPayload = {
  ref: string;
  installation?: { id: number } | null;
  repository: { full_name: string };
};

type PullRequestPayload = {
  installation?: { id: number } | null;
  repository: { full_name: string };
  pull_request: {
    number: number;
    base: { ref: string };
  };
};

function logQueueFailure(context: string, error: unknown): void {
  console.error(
    `[queuePullRequestMergeabilityCheck] ${context}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

export async function queueBaseBranchMergeabilityCheck(
  payload: PushPayload,
): Promise<void> {
  // Best effort: mergeability queueing must never fail the webhook delivery,
  // which would also drop the co-located pre-existing handlers.
  try {
    const installationId = payload.installation?.id;
    const refPrefix = 'refs/heads/';
    if (!installationId || !payload.ref.startsWith(refPrefix)) return;
    const repository = payload.repository.full_name;
    if (isRepoSkipped(repository)) return;

    const baseRef = payload.ref.slice(refPrefix.length);
    const candidates = await listTrackedPullRequestsForMergeability({
      repository,
      baseRef,
    });
    if (candidates.length === 0) return;

    await enqueuePullRequestMergeabilityCheck({
      installationId,
      repository,
      baseRef,
      deduplicationKey: `base:${repository}:${baseRef}`,
      retryAttempt: 0,
      allowNotifiedConflictCheck: true,
    });
  } catch (error) {
    logQueueFailure(`push ${payload.repository.full_name}`, error);
  }
}

export async function queueTrackedPullRequestMergeabilityCheck(
  payload: PullRequestPayload,
  options: { updateBaseRef?: boolean } = {},
): Promise<void> {
  // Best effort: see queueBaseBranchMergeabilityCheck.
  try {
    const installationId = payload.installation?.id;
    if (!installationId) return;

    const repository = payload.repository.full_name;
    if (isRepoSkipped(repository)) return;
    const prNumber = payload.pull_request.number;

    // Only base-change edits need the eager write; the job re-syncs
    // baseRefName from GitHub for every checked PR anyway.
    if (options.updateBaseRef) {
      await updateTrackedPullRequestBaseRef({
        repository,
        prNumber,
        baseRef: payload.pull_request.base.ref,
      });
    }

    // Enqueued unconditionally: the job resolves the tracked rows at run
    // time, so an opened webhook that races the task's own PR persistence
    // still gets its baseline check 45 seconds later.
    await enqueuePullRequestMergeabilityCheck({
      installationId,
      repository,
      prNumber,
      deduplicationKey: `pr:${repository}:${prNumber}`,
      retryAttempt: 0,
      // A synchronize event is how a previously conflicting PR reports a
      // conflict-resolution push, so it must be allowed to re-arm the state.
      allowNotifiedConflictCheck: true,
    });
  } catch (error) {
    logQueueFailure(
      `pull_request ${payload.repository.full_name}#${payload.pull_request.number}`,
      error,
    );
  }
}
