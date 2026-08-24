import {
  listTrackedPullRequestsForMergeability,
  updateTrackedPullRequestBaseRef,
} from '@roomote/db/server';
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

export async function queueBaseBranchMergeabilityCheck(
  payload: PushPayload,
): Promise<void> {
  const installationId = payload.installation?.id;
  const refPrefix = 'refs/heads/';
  if (!installationId || !payload.ref.startsWith(refPrefix)) return;

  const baseRef = payload.ref.slice(refPrefix.length);
  const candidates = await listTrackedPullRequestsForMergeability({
    repository: payload.repository.full_name,
    baseRef,
  });
  if (candidates.length === 0) return;

  await enqueuePullRequestMergeabilityCheck({
    installationId,
    repository: payload.repository.full_name,
    taskPullRequestIds: candidates.map((candidate) => candidate.id),
    deduplicationKey: `base:${payload.repository.full_name}:${baseRef}`,
    retryAttempt: 0,
    allowNotifiedConflictCheck: true,
  });
}

export async function queueTrackedPullRequestMergeabilityCheck(
  payload: PullRequestPayload,
): Promise<void> {
  const installationId = payload.installation?.id;
  if (!installationId) return;

  const repository = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  await updateTrackedPullRequestBaseRef({
    repository,
    prNumber,
    baseRef: payload.pull_request.base.ref,
  });
  const candidates = await listTrackedPullRequestsForMergeability({
    repository,
    prNumber,
  });
  if (candidates.length === 0) return;

  await enqueuePullRequestMergeabilityCheck({
    installationId,
    repository,
    taskPullRequestIds: candidates.map((candidate) => candidate.id),
    deduplicationKey: `pr:${repository}:${prNumber}`,
    retryAttempt: 0,
    // A synchronize event is how a previously conflicting PR reports a
    // conflict-resolution push, so it must be allowed to re-arm the state.
    allowNotifiedConflictCheck: true,
  });
}
