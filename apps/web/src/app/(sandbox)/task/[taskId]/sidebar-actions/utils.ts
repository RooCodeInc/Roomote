import { TaskPayloadKind } from '@roomote/types';

import type { TaskRunDetail } from '@/lib/server/task-runs';

import type { ArtifactGroup } from './types';

const TASK_TOOLS_HIDDEN_PAYLOAD_KINDS: ReadonlySet<string> = new Set<string>([
  TaskPayloadKind.GithubPrReview,
  TaskPayloadKind.GithubPrReviewSync,
]);

export function shouldShowTaskToolsActions(
  taskRunPayloadKind: string | null | undefined,
): boolean {
  return (
    !!taskRunPayloadKind &&
    !TASK_TOOLS_HIDDEN_PAYLOAD_KINDS.has(taskRunPayloadKind)
  );
}

/**
 * A task run is "asleep" when BullMQ has claimed its due sleep transition,
 * when a manual snapshot is in progress, or when it already has a created
 * snapshot. In any of those states the container is unavailable, so
 * interactive features like Preview and Editor should be disabled.
 */
export function isTaskRunAsleep(
  taskRun: TaskRunDetail | null | undefined,
): boolean {
  if (!taskRun) return false;

  const isGoingToSleep =
    (!!taskRun.sleepRequestedAt || !!taskRun.snapshotRequestedAt) &&
    !taskRun.snapshotCreatedAt &&
    !taskRun.snapshotFailedAt;

  return isGoingToSleep || !!taskRun.snapshotId;
}

/**
 * A snapshot is actively being taken for the task run. Unlike
 * `isTaskRunAsleep`, this excludes the `sleepRequestedAt`-only window so it
 * stays aligned with the transcript's "Going to sleep" row: non-resumable
 * teardowns set `sleepRequestedAt` without ever snapshotting.
 */
export function isTaskRunSnapshotting(
  taskRun: TaskRunDetail | null | undefined,
): boolean {
  return (
    !!taskRun?.snapshotRequestedAt &&
    !taskRun.snapshotCreatedAt &&
    !taskRun.snapshotFailedAt
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
