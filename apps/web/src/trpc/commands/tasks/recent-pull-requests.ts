import {
  and,
  count,
  db,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  tasks,
  taskPullRequests,
} from '@roomote/db/server';
import type { PullRequestStatus, SourceControlProvider } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { customAutomationTaskAccess } from '@/lib/server/custom-automation-task-access';

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
): Promise<{ pullRequests: RecentPullRequest[]; openCount: number }> {
  const eligiblePullRequests = and(
    eq(tasks.initiatorUserId, auth.userId),
    isNull(tasks.deletedAt),
    customAutomationTaskAccess(auth),
    isNotNull(taskPullRequests.repository),
    isNotNull(taskPullRequests.prNumber),
  );
  // Legacy associations may predate host backfills, but their PR URL still
  // identifies the source-control instance.
  const normalizedPullRequestHost = sql<string>`coalesce(
    nullif(lower(${taskPullRequests.host}), ''),
    nullif(lower(split_part(split_part(${taskPullRequests.prUrl}, '://', 2), '/', 1)), '')
  )`;

  const latestPullRequestStatuses = db
    .selectDistinctOn(
      [
        taskPullRequests.sourceControlProvider,
        normalizedPullRequestHost,
        taskPullRequests.repository,
        taskPullRequests.prNumber,
      ],
      { status: taskPullRequests.status },
    )
    .from(taskPullRequests)
    .innerJoin(tasks, eq(taskPullRequests.taskId, tasks.id))
    .where(eligiblePullRequests)
    .orderBy(
      taskPullRequests.sourceControlProvider,
      normalizedPullRequestHost,
      taskPullRequests.repository,
      taskPullRequests.prNumber,
      desc(taskPullRequests.detectedAt),
    )
    .as('latest_pull_request_statuses');

  // Query task_pull_requests joined with tasks for org/user filtering.
  const [rows, [openCountRow]] = await Promise.all([
    db
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
      .where(eligiblePullRequests)
      .orderBy(desc(taskPullRequests.detectedAt))
      .limit(100),
    db
      .select({ count: count() })
      .from(latestPullRequestStatuses)
      .where(inArray(latestPullRequestStatuses.status, ['draft', 'open'])),
  ]);

  // Deduplicate by repo#prNumber and collect up to 15 unique PRs.
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

  return {
    pullRequests: recentPullRequests,
    openCount: openCountRow?.count ?? 0,
  };
}
