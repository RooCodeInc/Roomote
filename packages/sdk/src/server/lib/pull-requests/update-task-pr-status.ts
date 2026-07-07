import { db, taskPullRequests, and, eq } from '@roomote/db/server';
import type { PullRequestStatus, SourceControlProvider } from '@roomote/types';

/**
 * Updates the status of all `task_pull_requests` rows matching the given
 * provider, repository, and PR number. This is a no-op when no matching rows
 * exist (e.g. the PR was not created by a Roomote task).
 */
export async function updateTaskPrStatus(
  provider: SourceControlProvider,
  repository: string,
  prNumber: number,
  status: PullRequestStatus,
): Promise<void> {
  await db
    .update(taskPullRequests)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(taskPullRequests.sourceControlProvider, provider),
        eq(taskPullRequests.repository, repository),
        eq(taskPullRequests.prNumber, prNumber),
      ),
    );
}
