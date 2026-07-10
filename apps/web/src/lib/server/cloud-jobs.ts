import {
  type CloudTaskStatus,
  type CloudTaskPayload,
  type TaskPayloadKind,
  exitedCloudTaskStatuses,
  type SourceControlProvider,
} from '@roomote/types';
import {
  type Run,
  type User,
  db,
  taskRuns,
  taskPullRequests,
  users,
  inArray,
  not,
  eq,
  and,
  desc,
  isNotNull,
} from '@roomote/db/server';

export type SimpleCloudJob = {
  id: number;
  payloadKind: TaskPayloadKind;
  payload: CloudTaskPayload;
  status: CloudTaskStatus;
  taskPhase: string | null;
  firstAssistantOutputAt: Date | null;
  prRepo: string | null;
  prNumber: number | null;
};

type TaskPullRequestLink = {
  taskId: string;
  repository: string;
  prNumber: number;
  sourceControlProvider: SourceControlProvider;
};

export const getLatestTaskPullRequestsByTaskId = async (
  taskIds: string[],
): Promise<Record<string, TaskPullRequestLink>> => {
  if (taskIds.length === 0) {
    return {};
  }

  const results = await db
    .select({
      taskId: taskPullRequests.taskId,
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      sourceControlProvider: taskPullRequests.sourceControlProvider,
    })
    .from(taskPullRequests)
    .where(
      and(
        inArray(taskPullRequests.taskId, taskIds),
        isNotNull(taskPullRequests.repository),
        isNotNull(taskPullRequests.prNumber),
      ),
    )
    .orderBy(
      taskPullRequests.taskId,
      desc(taskPullRequests.detectedAt),
      desc(taskPullRequests.createdAt),
    );

  const latestByTask = new Map<string, TaskPullRequestLink>();

  for (const row of results) {
    if (
      !latestByTask.has(row.taskId) &&
      row.repository &&
      row.prNumber !== null
    ) {
      latestByTask.set(row.taskId, {
        taskId: row.taskId,
        repository: row.repository,
        prNumber: row.prNumber,
        sourceControlProvider: row.sourceControlProvider,
      });
    }
  }

  return Object.fromEntries(latestByTask);
};

/**
 * Fetches the latest run for each task ID (by highest run ID). Runs supply
 * live runtime status/phase/preview fields only; PR badges come from
 * task_pull_requests.
 */
export const getLatestCloudJobsByTaskId = async (
  taskIds: string[],
): Promise<Record<string, SimpleCloudJob>> => {
  if (taskIds.length === 0) {
    return {};
  }

  const [results, taskPullRequestsByTaskId] = await Promise.all([
    db
      .select({
        id: taskRuns.id,
        taskId: taskRuns.taskId,
        payloadKind: taskRuns.payloadKind,
        payload: taskRuns.payload,
        status: taskRuns.status,
        taskPhase: taskRuns.taskPhase,
        firstAssistantOutputAt: taskRuns.firstAssistantOutputAt,
      })
      .from(taskRuns)
      .where(inArray(taskRuns.taskId, taskIds))
      .orderBy(taskRuns.taskId, desc(taskRuns.id)),
    getLatestTaskPullRequestsByTaskId(taskIds),
  ]);

  // Deduplicate to latest run per task (first seen per taskId wins due to
  // DESC id ordering).
  const latestByTask = new Map<string, SimpleCloudJob>();

  for (const row of results) {
    if (!latestByTask.has(row.taskId)) {
      const fallbackPr = taskPullRequestsByTaskId[row.taskId];

      latestByTask.set(row.taskId, {
        id: row.id,
        payloadKind: row.payloadKind,
        payload: row.payload,
        status: row.status,
        taskPhase: row.taskPhase,
        firstAssistantOutputAt: row.firstAssistantOutputAt,
        prRepo: fallbackPr?.repository ?? null,
        prNumber: fallbackPr?.prNumber ?? null,
      });
    }
  }

  return Object.fromEntries(latestByTask);
};

export type CloudJobDetail = Run & {
  refetchInterval?: number;
  user: User | null;
  actingUser?: User | null;
};

/**
 * Finds an active (non-exited) successor run on the same task as the given
 * source run. Resume chains all share the task, so this is a plain
 * "active run WHERE taskId = X" lookup.
 */
export const findActiveSuccessorCloudJob = async (
  sourceCloudJobId: number,
  _auth: { userId: string },
  taskId?: string | null,
): Promise<CloudJobDetail | null> => {
  // If we have a taskId, search for any active run sharing that task (handles
  // multi-hop chains). Otherwise fall back to direct source_run_id lookup.
  const jobFilter = taskId
    ? and(eq(taskRuns.taskId, taskId), not(eq(taskRuns.id, sourceCloudJobId)))
    : eq(taskRuns.sourceRunId, sourceCloudJobId);

  const successor = await db.query.taskRuns.findFirst({
    where: and(
      jobFilter,
      not(inArray(taskRuns.status, [...exitedCloudTaskStatuses])),
    ),
    orderBy: [desc(taskRuns.id)],
  });

  if (!successor) {
    return null;
  }

  const actingUser = successor.actingUserId
    ? ((await db.query.users.findFirst({
        where: eq(users.id, successor.actingUserId),
      })) ?? null)
    : null;

  return {
    ...successor,
    user: actingUser,
    actingUser,
    refetchInterval: undefined,
  };
};
