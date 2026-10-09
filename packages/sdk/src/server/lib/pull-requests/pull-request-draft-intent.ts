import { and, db, eq, taskPullRequests } from '@roomote/db/server';
import { acquireGithubPrReviewLifecycleLock } from '../task-runs/github-pr-review-check';
import type { RepositoryRow } from './source-control-pull-request-shared';

export async function acquirePullRequestDraftTransitionLock(
  repository: RepositoryRow,
  prNumber: number,
) {
  const release = await acquireGithubPrReviewLifecycleLock(
    `${repository.sourceControlProvider}:${repository.host ?? ''}:${repository.fullName}`,
    prNumber,
  );
  if (!release) {
    throw new Error(
      `Timed out serializing draft transition for ${repository.fullName}#${prNumber}`,
    );
  }
  return release;
}

function associationIdentity(repository: RepositoryRow, prNumber: number) {
  return and(
    eq(
      taskPullRequests.sourceControlProvider,
      repository.sourceControlProvider,
    ),
    eq(taskPullRequests.repositoryId, repository.id),
    eq(taskPullRequests.prNumber, prNumber),
  );
}

// Callers serialize reads/writes and provider transitions with the same lock.
export async function setPullRequestAutoReadyBlocked(
  repository: RepositoryRow,
  prNumber: number,
  blocked: boolean,
) {
  await db
    .update(taskPullRequests)
    .set({ autoReadyBlocked: blocked, updatedAt: new Date() })
    .where(associationIdentity(repository, prNumber));
}

export async function isPullRequestAutoReadyBlocked(
  repository: RepositoryRow,
  prNumber: number,
) {
  const held = await db.query.taskPullRequests.findFirst({
    where: and(
      associationIdentity(repository, prNumber),
      eq(taskPullRequests.autoReadyBlocked, true),
    ),
    columns: { id: true },
  });
  return held !== undefined;
}
