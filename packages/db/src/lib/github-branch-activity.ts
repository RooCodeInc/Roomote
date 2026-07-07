import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  type CloudTaskPayload,
  bootingCloudTaskStatuses,
  CloudTaskStatus,
  CloudTaskType,
  isActivelyRunningCloudTask,
  isExitedCloudTaskStatus,
  isResumableCloudTaskType,
  type SourceControlProvider,
} from '@roomote/types';

import { db } from '../db';
import { cloudJobs, taskPullRequests } from '../schema';

export const DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS = 30 * 60 * 1000;

export interface ActiveGitHubBranchWork {
  jobId: number;
  taskId: string;
  type: CloudTaskType;
  status: CloudTaskStatus;
  taskPhase: string | null;
  match: 'github_pr' | 'task_pull_request' | 'branch';
}

export interface ReusableGitHubPrFollowUpOwner extends ActiveGitHubBranchWork {
  delivery: 'attach' | 'resume';
}

const ACTIVE_WORK_STATUSES = [
  ...bootingCloudTaskStatuses,
  CloudTaskStatus.Running,
] as const;

const ACTIVE_WORK_COLUMNS = {
  jobId: cloudJobs.id,
  taskId: cloudJobs.taskId,
  type: cloudJobs.type,
  status: cloudJobs.status,
  taskPhase: cloudJobs.taskPhase,
} as const;

const REUSABLE_FOLLOW_UP_OWNER_COLUMNS = {
  id: cloudJobs.id,
  ...ACTIVE_WORK_COLUMNS,
  payload: cloudJobs.payload,
  snapshotId: cloudJobs.snapshotId,
  sourceCloudJobId: cloudJobs.sourceCloudJobId,
} as const;

const REUSABLE_FOLLOW_UP_OWNER_TYPES = [
  CloudTaskType.StandardTask,
  CloudTaskType.SlackAppMention,
  CloudTaskType.LinearAgentSession,
  CloudTaskType.SnapshotResume,
] as const;

const ACTIVE_PR_REVIEW_TYPES = [
  CloudTaskType.GithubPrReview,
  CloudTaskType.GithubPrReviewSync,
] as const;

type ActiveFollowUpOwnerCandidate = {
  id: number;
  taskId: string;
  type: CloudTaskType;
  status: CloudTaskStatus;
  taskPhase: string | null;
  payload: CloudTaskPayload;
  snapshotId: string | null;
  sourceCloudJobId: number | null;
};

type CloudJobReuseMetadata = {
  id: number;
  type: CloudTaskType;
  payload: CloudTaskPayload;
  snapshotId: string | null;
  sourceCloudJobId: number | null;
};

function pickActiveWork(
  rows: Array<{
    jobId: number;
    taskId: string;
    type: CloudTaskType;
    status: CloudTaskStatus;
    taskPhase: string | null;
  }>,
  match: ActiveGitHubBranchWork['match'],
): ActiveGitHubBranchWork | null {
  const activeRow = rows.find((row) =>
    isActivelyRunningCloudTask(row.status, row.taskPhase),
  );

  if (!activeRow) {
    return null;
  }

  return {
    jobId: activeRow.jobId,
    taskId: activeRow.taskId,
    type: activeRow.type,
    status: activeRow.status,
    taskPhase: activeRow.taskPhase,
    match,
  };
}

/**
 * Returns the newest active Roomote job that appears to be working on the same
 * PR or branch. Conflict-resolver jobs themselves are excluded because they are
 * handled separately by the dedicated dedup guard.
 */
export async function findActiveGitHubBranchWork({
  repoFullName,
  prNumber,
  branchName,
  sourceControlProvider = 'github',
}: {
  repoFullName: string;
  prNumber: number;
  branchName: string;
  sourceControlProvider?: SourceControlProvider;
}): Promise<ActiveGitHubBranchWork | null> {
  const baseConditions = [
    inArray(cloudJobs.status, [...ACTIVE_WORK_STATUSES]),
    isNull(cloudJobs.canceledAt),
    sql`${cloudJobs.type} != ${CloudTaskType.GithubPrConflictResolve}`,
  ] as const;

  const githubPrRows = await db
    .select(ACTIVE_WORK_COLUMNS)
    .from(cloudJobs)
    .where(
      and(
        ...baseConditions,
        eq(cloudJobs.prRepo, repoFullName),
        eq(cloudJobs.prNumber, prNumber),
      ),
    )
    .orderBy(desc(cloudJobs.createdAt))
    .limit(10);

  const githubPrMatch = pickActiveWork(githubPrRows, 'github_pr');

  if (githubPrMatch) {
    return githubPrMatch;
  }

  const taskPullRequestRows = await db
    .select(ACTIVE_WORK_COLUMNS)
    .from(cloudJobs)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, cloudJobs.taskId))
    .where(
      and(
        ...baseConditions,
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
      ),
    )
    .orderBy(desc(cloudJobs.createdAt))
    .limit(10);

  const taskPullRequestMatch = pickActiveWork(
    taskPullRequestRows,
    'task_pull_request',
  );

  if (taskPullRequestMatch) {
    return taskPullRequestMatch;
  }

  const branchRows = await db
    .select(ACTIVE_WORK_COLUMNS)
    .from(cloudJobs)
    .where(
      and(
        ...baseConditions,
        sql`${cloudJobs.payload}->>'repo' = ${repoFullName}`,
        sql`(
          ${cloudJobs.payload}->>'branch' = ${branchName}
          OR ${cloudJobs.payload}->>'headRef' = ${branchName}
        )`,
      ),
    )
    .orderBy(desc(cloudJobs.createdAt))
    .limit(10);

  return pickActiveWork(branchRows, 'branch');
}

/**
 * Returns the newest active Roomote job that can safely continue follow-up
 * work on the same PR branch without introducing a second writer or second
 * PR-scoped thread when an active owner already exists.
 */
export async function findReusableGitHubPrFollowUpOwner({
  repoFullName,
  prNumber,
  branchName,
  sourceControlProvider = 'github',
}: {
  repoFullName: string;
  prNumber: number;
  branchName: string;
  sourceControlProvider?: SourceControlProvider;
}): Promise<ReusableGitHubPrFollowUpOwner | null> {
  const baseConditions = [
    isNull(cloudJobs.canceledAt),
    sql`${cloudJobs.type} != ${CloudTaskType.GithubPrConflictResolve}`,
    inArray(cloudJobs.type, [...REUSABLE_FOLLOW_UP_OWNER_TYPES]),
  ];

  const githubPrRows = await db
    .select(REUSABLE_FOLLOW_UP_OWNER_COLUMNS)
    .from(cloudJobs)
    .where(
      and(
        ...baseConditions,
        eq(cloudJobs.prRepo, repoFullName),
        eq(cloudJobs.prNumber, prNumber),
      ),
    )
    .orderBy(desc(cloudJobs.createdAt));

  const githubPrMatch = await pickReusableFollowUpOwner(
    githubPrRows,
    'github_pr',
  );

  if (githubPrMatch) {
    return githubPrMatch;
  }

  const taskPullRequestRows = await db
    .select(REUSABLE_FOLLOW_UP_OWNER_COLUMNS)
    .from(cloudJobs)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, cloudJobs.taskId))
    .where(
      and(
        ...baseConditions,
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
      ),
    )
    .orderBy(desc(cloudJobs.createdAt));

  const taskPullRequestMatch = await pickReusableFollowUpOwner(
    taskPullRequestRows,
    'task_pull_request',
  );

  if (taskPullRequestMatch) {
    return taskPullRequestMatch;
  }

  const branchRows = await db
    .select(REUSABLE_FOLLOW_UP_OWNER_COLUMNS)
    .from(cloudJobs)
    .where(
      and(
        ...baseConditions,
        sql`${cloudJobs.payload}->>'repo' = ${repoFullName}`,
        sql`(
          ${cloudJobs.payload}->>'branch' = ${branchName}
          OR ${cloudJobs.payload}->>'headRef' = ${branchName}
        )`,
      ),
    )
    .orderBy(desc(cloudJobs.createdAt));

  return pickReusableFollowUpOwner(branchRows, 'branch');
}

/**
 * Returns the newest active PR review task for the same pull request.
 *
 * `sourceControlProvider` optionally scopes the lookup to review jobs enqueued
 * for a specific provider (e.g. `'gitlab'`, `'gitea'`, `'ado'`). Without it the
 * lookup matches review jobs for any provider, which is safe because
 * `(repo, prNumber, headSha)` is specific enough in practice. Callers that know
 * the provider should pass it so a same-named repo/PR across two providers can
 * never cross-match.
 */
export async function findActiveGitHubPrReviewTask({
  repoFullName,
  prNumber,
  headSha,
  sourceControlProvider,
}: {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  sourceControlProvider?: SourceControlProvider;
}): Promise<ActiveGitHubBranchWork | null> {
  const reviewRows = await db
    .select(ACTIVE_WORK_COLUMNS)
    .from(cloudJobs)
    .where(
      and(
        inArray(cloudJobs.status, [...ACTIVE_WORK_STATUSES]),
        isNull(cloudJobs.canceledAt),
        inArray(cloudJobs.type, [...ACTIVE_PR_REVIEW_TYPES]),
        eq(cloudJobs.prRepo, repoFullName),
        eq(cloudJobs.prNumber, prNumber),
        eq(cloudJobs.prSha, headSha),
        ...(sourceControlProvider
          ? [eq(cloudJobs.prSourceControlProvider, sourceControlProvider)]
          : []),
      ),
    )
    .orderBy(desc(cloudJobs.createdAt))
    .limit(10);

  return pickActiveWork(reviewRows, 'github_pr');
}

async function fetchCloudJobReuseMetadata(
  cloudJobId: number,
): Promise<CloudJobReuseMetadata | null> {
  return (
    (await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, cloudJobId),
      columns: {
        id: true,
        type: true,
        payload: true,
        snapshotId: true,
        sourceCloudJobId: true,
      },
    })) ?? null
  );
}

async function isReusableFollowUpOwnerCandidate(
  row: ActiveFollowUpOwnerCandidate,
): Promise<boolean> {
  return isReusableFollowUpOwnerJob({
    id: row.id,
    type: row.type,
    payload: row.payload,
    snapshotId: row.snapshotId,
    sourceCloudJobId: row.sourceCloudJobId,
  });
}

async function fetchLatestReusableFollowUpOwnerJob(
  taskId: string,
): Promise<ActiveFollowUpOwnerCandidate | null> {
  return (
    (await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.taskId, taskId),
      orderBy: desc(cloudJobs.createdAt),
      columns: {
        id: true,
        taskId: true,
        type: true,
        status: true,
        taskPhase: true,
        payload: true,
        snapshotId: true,
        sourceCloudJobId: true,
      },
    })) ?? null
  );
}

async function isReusableFollowUpOwnerJob(
  job: CloudJobReuseMetadata,
  visitedIds = new Set<number>(),
): Promise<boolean> {
  switch (job.type) {
    case CloudTaskType.StandardTask:
    case CloudTaskType.SlackAppMention:
    case CloudTaskType.LinearAgentSession:
      return true;
    case CloudTaskType.SnapshotResume: {
      const sourceCloudJobId = job.sourceCloudJobId;

      if (!sourceCloudJobId || visitedIds.has(sourceCloudJobId)) {
        return false;
      }

      visitedIds.add(sourceCloudJobId);

      const sourceJob = await fetchCloudJobReuseMetadata(sourceCloudJobId);

      if (!sourceJob) {
        return false;
      }

      return isReusableFollowUpOwnerJob(sourceJob, visitedIds);
    }
    default:
      return false;
  }
}

async function pickReusableFollowUpOwner(
  rows: ActiveFollowUpOwnerCandidate[],
  match: ActiveGitHubBranchWork['match'],
): Promise<ReusableGitHubPrFollowUpOwner | null> {
  const seenTaskIds = new Set<string>();

  for (const row of rows) {
    if (seenTaskIds.has(row.taskId)) {
      continue;
    }

    seenTaskIds.add(row.taskId);

    const latestJob = await fetchLatestReusableFollowUpOwnerJob(row.taskId);

    if (!latestJob) {
      continue;
    }

    if (!(await isReusableFollowUpOwnerCandidate(latestJob))) {
      continue;
    }

    if (!isExitedCloudTaskStatus(latestJob.status)) {
      return {
        jobId: latestJob.id,
        taskId: latestJob.taskId,
        type: latestJob.type,
        status: latestJob.status,
        taskPhase: latestJob.taskPhase,
        match,
        delivery: 'attach',
      };
    }

    if (
      latestJob.snapshotId &&
      isResumableCloudTaskType(latestJob.type) &&
      !isActivelyRunningCloudTask(latestJob.status, latestJob.taskPhase)
    ) {
      return {
        jobId: latestJob.id,
        taskId: latestJob.taskId,
        type: latestJob.type,
        status: latestJob.status,
        taskPhase: latestJob.taskPhase,
        match,
        delivery: 'resume',
      };
    }
  }

  return null;
}

export function hasRecentGitHubBranchCommit({
  latestCommitAt,
  now = new Date(),
  idleWindowMs = DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS,
}: {
  latestCommitAt?: Date | null;
  now?: Date;
  idleWindowMs?: number;
}): boolean {
  if (!latestCommitAt) {
    return false;
  }

  return now.getTime() - latestCommitAt.getTime() < idleWindowMs;
}
