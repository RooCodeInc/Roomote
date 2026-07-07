import { CloudTaskType } from '@roomote/types';

import type { CloudJobDetail } from '@/lib/server/cloud-jobs';

import type { ArtifactGroup } from './types';

const TASK_TOOLS_HIDDEN_TYPES: ReadonlySet<string> = new Set<string>([
  CloudTaskType.GithubPrReview,
  CloudTaskType.GithubPrReviewSync,
]);

export function shouldShowTaskToolsActions(
  cloudJobType: string | null | undefined,
): boolean {
  return !!cloudJobType && !TASK_TOOLS_HIDDEN_TYPES.has(cloudJobType);
}

/**
 * A cloud job is "asleep" when BullMQ has claimed its due sleep transition,
 * when a manual snapshot is in progress, or when it already has a created
 * snapshot. In any of those states the container is unavailable, so
 * interactive features like Preview and Editor should be disabled.
 */
export function isCloudJobAsleep(
  cloudJob: CloudJobDetail | null | undefined,
): boolean {
  if (!cloudJob) return false;

  const isGoingToSleep =
    (!!cloudJob.sleepRequestedAt || !!cloudJob.snapshotRequestedAt) &&
    !cloudJob.snapshotCreatedAt &&
    !cloudJob.snapshotFailedAt;

  return isGoingToSleep || !!cloudJob.snapshotId;
}

/**
 * A snapshot is actively being taken for the cloud job. Unlike
 * `isCloudJobAsleep`, this excludes the `sleepRequestedAt`-only window so it
 * stays aligned with the transcript's "Going to sleep" row: non-resumable
 * teardowns set `sleepRequestedAt` without ever snapshotting.
 */
export function isCloudJobSnapshotting(
  cloudJob: CloudJobDetail | null | undefined,
): boolean {
  return (
    !!cloudJob?.snapshotRequestedAt &&
    !cloudJob.snapshotCreatedAt &&
    !cloudJob.snapshotFailedAt
  );
}

/**
 * Groups artifacts by path, with the latest version first.
 * Returns an array of ArtifactGroup objects sorted by latest artifact's
 * createdAt desc.
 */
export function groupArtifactsByPath<
  T extends { path: string; version: number; createdAt: Date | string },
>(artifacts: T[]): ArtifactGroup<T>[] {
  const groupMap = new Map<string, T[]>();

  // Group by path.
  for (const artifact of artifacts) {
    const existing = groupMap.get(artifact.path) || [];
    existing.push(artifact);
    groupMap.set(artifact.path, existing);
  }

  // Convert to array and sort each group by version desc.
  const groups: ArtifactGroup<T>[] = [];

  for (const [path, versions] of groupMap) {
    // Sort by version descending (highest first).
    versions.sort((a, b) => b.version - a.version);
    const [latest, ...olderVersions] = versions;

    if (latest) {
      groups.push({ path, latest, olderVersions });
    }
  }

  // Sort groups by latest artifact's createdAt descending.
  groups.sort(
    (a, b) =>
      new Date(b.latest.createdAt).getTime() -
      new Date(a.latest.createdAt).getTime(),
  );

  return groups;
}
