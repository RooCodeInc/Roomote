import {
  type CloudTaskStatus,
  type CloudTaskPayload,
  CloudTaskType,
  exitedCloudTaskStatuses,
  type SourceControlProvider,
} from '@roomote/types';
import {
  type CloudJob,
  type User,
  db,
  cloudJobs,
  taskPullRequests,
  inArray,
  not,
  eq,
  and,
  desc,
  isNotNull,
} from '@roomote/db/server';

export type SimpleCloudJob = {
  id: number;
  type: CloudTaskType;
  payload: CloudTaskPayload;
  status: CloudTaskStatus;
  taskPhase: string | null;
  firstAssistantOutputAt: Date | null;
  prRepo: string | null;
  prNumber: number | null;
  githubLogin: string | null;
};

type TaskPullRequestLink = {
  taskId: string;
  repository: string;
  prNumber: number;
  sourceControlProvider: SourceControlProvider;
};

type CloudJobWithPrLink = {
  prRepo: string | null;
  prNumber: number | null;
};

/**
 * task_pull_requests is the durable task-level PR association, but it only
 * stores repository + PR number. Callers that also need prSha still need
 * cloud-job-row propagation for that field.
 */
export function applyTaskPullRequestFallbackToCloudJob<
  T extends CloudJobWithPrLink,
>(cloudJob: T, fallbackPr: TaskPullRequestLink | undefined): T;
export function applyTaskPullRequestFallbackToCloudJob<
  T extends CloudJobWithPrLink,
>(cloudJob: T | null, fallbackPr: TaskPullRequestLink | undefined): T | null;
export function applyTaskPullRequestFallbackToCloudJob<
  T extends CloudJobWithPrLink,
>(cloudJob: T | null, fallbackPr: TaskPullRequestLink | undefined): T | null {
  if (
    !cloudJob ||
    !fallbackPr ||
    (cloudJob.prRepo !== null && cloudJob.prNumber !== null)
  ) {
    return cloudJob;
  }

  return {
    ...cloudJob,
    prRepo: cloudJob.prRepo ?? fallbackPr.repository,
    prNumber: cloudJob.prNumber ?? fallbackPr.prNumber,
  };
}

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
 * Fetches the latest cloud job for each task ID (by highest cloud job ID).
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
        id: cloudJobs.id,
        taskId: cloudJobs.taskId,
        type: cloudJobs.type,
        payload: cloudJobs.payload,
        status: cloudJobs.status,
        taskPhase: cloudJobs.taskPhase,
        firstAssistantOutputAt: cloudJobs.firstAssistantOutputAt,
        prRepo: cloudJobs.prRepo,
        prNumber: cloudJobs.prNumber,
        githubLogin: cloudJobs.githubLogin,
      })
      .from(cloudJobs)
      .where(inArray(cloudJobs.taskId, taskIds))
      .orderBy(cloudJobs.taskId, desc(cloudJobs.id)),
    getLatestTaskPullRequestsByTaskId(taskIds),
  ]);

  // Deduplicate to latest job per task (first seen per taskId wins due to
  // DESC id ordering).
  const latestByTask = new Map<string, (typeof results)[number]>();

  for (const row of results) {
    if (!latestByTask.has(row.taskId)) {
      latestByTask.set(
        row.taskId,
        applyTaskPullRequestFallbackToCloudJob(
          row,
          taskPullRequestsByTaskId[row.taskId],
        )!,
      );
    }
  }

  return Object.fromEntries(latestByTask) as Record<string, SimpleCloudJob>;
};

export type CloudJobDetail = CloudJob & {
  refetchInterval?: number;
  user: User | null;
  actingUser?: User | null;
};

/**
 * Finds an active (non-exited) successor cloud job that shares the same taskId as
 * the given source cloud job. This handles multi-hop snapshot resume chains
 * (e.g. job A → snapshot → job B → snapshot → job C) by searching all jobs
 * with the same taskId rather than only direct successors.
 */
export const findActiveSuccessorCloudJob = async (
  sourceCloudJobId: number,
  auth: { userId: string },
  taskId?: string | null,
): Promise<CloudJobDetail | null> => {
  const { userId } = auth;

  // If we have a taskId, search for any active job sharing that task (handles
  // multi-hop chains). Otherwise fall back to direct source_cloud_job_id lookup.
  const jobFilter = taskId
    ? and(eq(cloudJobs.taskId, taskId), not(eq(cloudJobs.id, sourceCloudJobId)))
    : eq(cloudJobs.sourceCloudJobId, sourceCloudJobId);

  const successor = await db.query.cloudJobs.findFirst({
    where: and(
      jobFilter,
      not(inArray(cloudJobs.status, [...exitedCloudTaskStatuses])),
      eq(cloudJobs.userId, userId),
    ),
    with: { user: true },
    orderBy: [desc(cloudJobs.id)],
  });

  if (!successor) {
    return null;
  }

  return { ...successor, refetchInterval: undefined };
};
