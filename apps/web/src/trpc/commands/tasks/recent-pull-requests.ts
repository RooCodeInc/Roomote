import {
  and,
  db,
  desc,
  eq,
  isNotNull,
  isNull,
  tasks,
  taskPullRequests,
} from '@roomote/db/server';
import type { PullRequestStatus, SourceControlProvider } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

type RecentPullRequest = {
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  taskId: string;
  createdAt: Date;
  status: PullRequestStatus | null;
  sourceControlProvider: SourceControlProvider;
};

export async function getRecentPullRequestsCommand(
  auth: UserAuthSuccess,
): Promise<RecentPullRequest[]> {
  // Query task_pull_requests joined with tasks for org/user filtering.
  const rows = await db
    .select({
      repo: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      prTitle: taskPullRequests.prTitle,
      prUrl: taskPullRequests.prUrl,
      taskId: taskPullRequests.taskId,
      createdAt: taskPullRequests.detectedAt,
      status: taskPullRequests.status,
      sourceControlProvider: taskPullRequests.sourceControlProvider,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(taskPullRequests.taskId, tasks.id))
    .where(
      and(
        eq(tasks.initiatorUserId, auth.userId),
        isNull(tasks.deletedAt),
        isNotNull(taskPullRequests.repository),
        isNotNull(taskPullRequests.prNumber),
      ),
    )
    .orderBy(desc(taskPullRequests.detectedAt))
    .limit(100);

  // Deduplicate by repo#prNumber and collect up to 10 unique PRs.
  const recentPullRequests: RecentPullRequest[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.repo || row.prNumber === null || !row.createdAt) {
      continue;
    }

    const key = `${row.sourceControlProvider}:${row.repo}#${row.prNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    recentPullRequests.push({
      repo: row.repo,
      prNumber: row.prNumber,
      prTitle: row.prTitle ?? `#${row.prNumber}`,
      prUrl: row.prUrl,
      taskId: row.taskId,
      createdAt: row.createdAt,
      status: row.status,
      sourceControlProvider: row.sourceControlProvider,
    });

    if (recentPullRequests.length >= 15) {
      break;
    }
  }

  return recentPullRequests;
}
