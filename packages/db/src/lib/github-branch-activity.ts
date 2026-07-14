import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import {
  type TaskPayload,
  bootingRunStatuses,
  RunStatus,
  TaskPayloadKind,
  isActivelyRunningTask,
  isExitedRunStatus,
  isResumableTaskPayloadKind,
  type SourceControlProvider,
} from '@roomote/types';

import { db } from '../db';
import { taskRuns, taskPullRequests } from '../schema';

export const DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS = 30 * 60 * 1000;

export interface ActiveGitHubBranchWork {
  runId: number;
  taskId: string;
  type: TaskPayloadKind;
  status: RunStatus;
  taskPhase: string | null;
  match: 'task_pull_request' | 'branch';
}

export interface ReusableGitHubPrFollowUpOwner extends ActiveGitHubBranchWork {
  delivery: 'attach' | 'resume';
}

const ACTIVE_WORK_STATUSES = [
  ...bootingRunStatuses,
  RunStatus.Running,
] as const;

const ACTIVE_WORK_COLUMNS = {
  runId: taskRuns.id,
  taskId: taskRuns.taskId,
  type: taskRuns.payloadKind,
  status: taskRuns.status,
  taskPhase: taskRuns.taskPhase,
} as const;

const REUSABLE_FOLLOW_UP_OWNER_COLUMNS = {
  id: taskRuns.id,
  ...ACTIVE_WORK_COLUMNS,
  payload: taskRuns.payload,
  snapshotId: taskRuns.snapshotId,
  sourceRunId: taskRuns.sourceRunId,
} as const;

const REUSABLE_FOLLOW_UP_OWNER_TYPES = [
  TaskPayloadKind.StandardTask,
  TaskPayloadKind.SlackAppMention,
  TaskPayloadKind.LinearAgentSession,
  TaskPayloadKind.SnapshotResume,
] as const;

const ACTIVE_PR_REVIEW_TYPES = [
  TaskPayloadKind.GithubPrReview,
  TaskPayloadKind.GithubPrReviewSync,
] as const;

type ActiveFollowUpOwnerCandidate = {
  id: number;
  taskId: string;
  type: TaskPayloadKind;
  status: RunStatus;
  taskPhase: string | null;
  payload: TaskPayload;
  snapshotId: string | null;
  sourceRunId: number | null;
};

type RunReuseMetadata = {
  id: number;
  type: TaskPayloadKind;
  payload: TaskPayload;
  snapshotId: string | null;
  sourceRunId: number | null;
};

function pickActiveWork(
  rows: Array<{
    runId: number;
    taskId: string;
    type: TaskPayloadKind;
    status: RunStatus;
    taskPhase: string | null;
  }>,
  match: ActiveGitHubBranchWork['match'],
): ActiveGitHubBranchWork | null {
  const activeRow = rows.find((row) =>
    isActivelyRunningTask(row.status, row.taskPhase),
  );

  if (!activeRow) {
    return null;
  }

  return {
    runId: activeRow.runId,
    taskId: activeRow.taskId,
    type: activeRow.type,
    status: activeRow.status,
    taskPhase: activeRow.taskPhase,
    match,
  };
}

/**
 * Returns the newest active Roomote run that appears to be working on the same
 * PR or branch. Conflict-resolver runs themselves are excluded because they are
 * handled separately by the dedicated dedup guard.
 *
 * PR association lives exclusively on `task_pull_requests` (populated at
 * enqueue for PR-triggered launches and at extraction time for agent-created
 * PRs), so PR matches are a `task_runs JOIN task_pull_requests` lookup.
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
    inArray(taskRuns.status, [...ACTIVE_WORK_STATUSES]),
    isNull(taskRuns.canceledAt),
    ne(taskRuns.payloadKind, TaskPayloadKind.GithubPrConflictResolve),
  ] as const;

  const taskPullRequestRows = await db
    .select(ACTIVE_WORK_COLUMNS)
    .from(taskRuns)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, taskRuns.taskId))
    .where(
      and(
        ...baseConditions,
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
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
    .from(taskRuns)
    .where(
      and(
        ...baseConditions,
        payloadProviderCondition(sourceControlProvider),
        sql`${taskRuns.payload}->>'repo' = ${repoFullName}`,
        sql`(
          ${taskRuns.payload}->>'branch' = ${branchName}
          OR ${taskRuns.payload}->>'headRef' = ${branchName}
        )`,
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(10);

  return pickActiveWork(branchRows, 'branch');
}

/**
 * Payload-side provider scoping for the branch fallback lookups. Payloads
 * written before provider-neutral support omit `sourceControlProvider` and
 * mean GitHub at runtime (see `normalizeSourceControlProvider`), so missing
 * or empty values are treated as `'github'`. This keeps a same-named
 * repo/branch on another provider from cross-matching GitHub work and vice
 * versa.
 */
function payloadProviderCondition(
  sourceControlProvider: SourceControlProvider,
) {
  return sql`COALESCE(NULLIF(${taskRuns.payload}->>'sourceControlProvider', ''), 'github') = ${sourceControlProvider}`;
}

/**
 * Returns the newest active Roomote run that can safely continue follow-up
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
    isNull(taskRuns.canceledAt),
    inArray(taskRuns.payloadKind, [...REUSABLE_FOLLOW_UP_OWNER_TYPES]),
  ];

  const taskPullRequestRows = await db
    .select(REUSABLE_FOLLOW_UP_OWNER_COLUMNS)
    .from(taskRuns)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, taskRuns.taskId))
    .where(
      and(
        ...baseConditions,
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
      ),
    )
    .orderBy(desc(taskRuns.createdAt));

  const taskPullRequestMatch = await pickReusableFollowUpOwner(
    taskPullRequestRows,
    'task_pull_request',
  );

  if (taskPullRequestMatch) {
    return taskPullRequestMatch;
  }

  const branchRows = await db
    .select(REUSABLE_FOLLOW_UP_OWNER_COLUMNS)
    .from(taskRuns)
    .where(
      and(
        ...baseConditions,
        payloadProviderCondition(sourceControlProvider),
        sql`${taskRuns.payload}->>'repo' = ${repoFullName}`,
        sql`(
          ${taskRuns.payload}->>'branch' = ${branchName}
          OR ${taskRuns.payload}->>'headRef' = ${branchName}
        )`,
      ),
    )
    .orderBy(desc(taskRuns.createdAt));

  return pickReusableFollowUpOwner(branchRows, 'branch');
}

/**
 * Returns the newest active PR review task for the same pull request.
 *
 * `sourceControlProvider` optionally scopes the lookup to review runs enqueued
 * for a specific provider (e.g. `'gitlab'`, `'gitea'`, `'ado'`). Without it the
 * lookup matches review runs for any provider, which is safe because
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
    .from(taskRuns)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, taskRuns.taskId))
    .where(
      and(
        inArray(taskRuns.status, [...ACTIVE_WORK_STATUSES]),
        isNull(taskRuns.canceledAt),
        inArray(taskRuns.payloadKind, [...ACTIVE_PR_REVIEW_TYPES]),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
        eq(taskPullRequests.prSha, headSha),
        ...(sourceControlProvider
          ? [eq(taskPullRequests.sourceControlProvider, sourceControlProvider)]
          : []),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(10);

  return pickActiveWork(reviewRows, 'task_pull_request');
}

async function fetchRunReuseMetadata(
  runId: number,
): Promise<RunReuseMetadata | null> {
  const row = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: {
      id: true,
      payloadKind: true,
      payload: true,
      snapshotId: true,
      sourceRunId: true,
    },
  });

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    type: row.payloadKind,
    payload: row.payload,
    snapshotId: row.snapshotId,
    sourceRunId: row.sourceRunId,
  };
}

async function isReusableFollowUpOwnerCandidate(
  row: ActiveFollowUpOwnerCandidate,
): Promise<boolean> {
  return isReusableFollowUpOwnerRun({
    id: row.id,
    type: row.type,
    payload: row.payload,
    snapshotId: row.snapshotId,
    sourceRunId: row.sourceRunId,
  });
}

async function fetchLatestReusableFollowUpOwnerRun(
  taskId: string,
): Promise<ActiveFollowUpOwnerCandidate | null> {
  const row = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, taskId),
    orderBy: desc(taskRuns.createdAt),
    columns: {
      id: true,
      taskId: true,
      payloadKind: true,
      status: true,
      taskPhase: true,
      payload: true,
      snapshotId: true,
      sourceRunId: true,
    },
  });

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    taskId: row.taskId,
    type: row.payloadKind,
    status: row.status,
    taskPhase: row.taskPhase,
    payload: row.payload,
    snapshotId: row.snapshotId,
    sourceRunId: row.sourceRunId,
  };
}

async function isReusableFollowUpOwnerRun(
  run: RunReuseMetadata,
  visitedIds = new Set<number>(),
): Promise<boolean> {
  switch (run.type) {
    case TaskPayloadKind.StandardTask:
    case TaskPayloadKind.SlackAppMention:
    case TaskPayloadKind.LinearAgentSession:
      return true;
    case TaskPayloadKind.SnapshotResume: {
      const sourceRunId = run.sourceRunId;

      if (!sourceRunId || visitedIds.has(sourceRunId)) {
        return false;
      }

      visitedIds.add(sourceRunId);

      const sourceRun = await fetchRunReuseMetadata(sourceRunId);

      if (!sourceRun) {
        return false;
      }

      return isReusableFollowUpOwnerRun(sourceRun, visitedIds);
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

    const latestRun = await fetchLatestReusableFollowUpOwnerRun(row.taskId);

    if (!latestRun) {
      continue;
    }

    if (!(await isReusableFollowUpOwnerCandidate(latestRun))) {
      continue;
    }

    if (!isExitedRunStatus(latestRun.status)) {
      return {
        runId: latestRun.id,
        taskId: latestRun.taskId,
        type: latestRun.type,
        status: latestRun.status,
        taskPhase: latestRun.taskPhase,
        match,
        delivery: 'attach',
      };
    }

    if (
      latestRun.snapshotId &&
      isResumableTaskPayloadKind(latestRun.type) &&
      !isActivelyRunningTask(latestRun.status, latestRun.taskPhase)
    ) {
      return {
        runId: latestRun.id,
        taskId: latestRun.taskId,
        type: latestRun.type,
        status: latestRun.status,
        taskPhase: latestRun.taskPhase,
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
