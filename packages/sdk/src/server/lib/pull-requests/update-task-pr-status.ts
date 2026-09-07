import {
  db,
  taskRuns,
  taskPullRequests,
  tasks,
  and,
  eq,
  isNull,
  inArray,
  ne,
  or,
  syncTaskStateFromRuns,
} from '@roomote/db/server';
import { captureActivationPrMerged } from '@roomote/telemetry/server';
import {
  activeRunStatuses,
  RunStatus,
  type PullRequestStatus,
  type SourceControlProvider,
  type TaskState,
} from '@roomote/types';

import { enqueueTaskSleep } from '../task-runs/enqueue-sleep';

const MERGED_PR_TASK_IDLE_SECONDS = 5 * 60;

type MergedPrTaskSleepInput = {
  state: TaskState;
  activityAt: number;
  activeRuns: Array<{ id: number; status: RunStatus }>;
};

export function selectMergedPrTaskRunToSleep(
  input: MergedPrTaskSleepInput,
  nowSeconds = Math.floor(Date.now() / 1_000),
): number | null {
  if (
    input.state !== 'active' ||
    input.activityAt > nowSeconds - MERGED_PR_TASK_IDLE_SECONDS ||
    input.activeRuns.length !== 1 ||
    input.activeRuns[0]?.status !== RunStatus.Idle
  ) {
    return null;
  }

  return input.activeRuns[0].id;
}

async function sleepMergedPrOriginatingTask(taskId: string): Promise<void> {
  const [task] = await db
    .select({ state: tasks.state, activityAt: tasks.activityAt })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) return;

  const activeRuns = await db
    .select({ id: taskRuns.id, status: taskRuns.status })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.taskId, taskId),
        inArray(taskRuns.status, [...activeRunStatuses]),
      ),
    );
  const runId = selectMergedPrTaskRunToSleep({ ...task, activeRuns });

  if (runId !== null) {
    await enqueueTaskSleep({
      runId,
      triggerPath: 'merged_pr',
      expectedTaskActivityAt: task.activityAt,
    });
  }
}

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
  const matchingPullRequest = and(
    eq(taskPullRequests.sourceControlProvider, provider),
    eq(taskPullRequests.repository, repository),
    eq(taskPullRequests.prNumber, prNumber),
  );
  const matchingStatus = and(
    matchingPullRequest,
    ...(status === 'merged'
      ? [
          or(
            isNull(taskPullRequests.status),
            ne(taskPullRequests.status, 'merged'),
          ),
        ]
      : []),
  );

  const { updated, originatingTaskId } = await db.transaction(async (tx) => {
    let originatingTaskId: string | null = null;
    if (status === 'merged') {
      const linkedTasks = await tx
        .select({
          taskId: taskPullRequests.taskId,
          createdByRoomote: taskPullRequests.createdByRoomote,
        })
        .from(taskPullRequests)
        .where(matchingPullRequest);

      for (const taskId of [
        ...new Set(linkedTasks.map((row) => row.taskId)),
      ].sort()) {
        // Match enqueue's task-before-PR lock order. Idle/running siblings
        // still derive active, so legitimate follow-up tasks stay open.
        await syncTaskStateFromRuns(tx, taskId);
      }

      originatingTaskId =
        linkedTasks.find(({ createdByRoomote }) => createdByRoomote)?.taskId ??
        null;
    }

    const updatedRows = await tx
      .update(taskPullRequests)
      .set({ status, updatedAt: new Date() })
      .where(matchingStatus)
      .returning({
        taskId: taskPullRequests.taskId,
        createdByRoomote: taskPullRequests.createdByRoomote,
      });

    return { updated: updatedRows, originatingTaskId };
  });

  if (status === 'merged' && originatingTaskId) {
    void sleepMergedPrOriginatingTask(originatingTaskId).catch((error) => {
      console.error(
        `[updateTaskPrStatus] Failed to enqueue merged-PR sleep for task ${originatingTaskId}:`,
        error,
      );
    });
  }

  if (status !== 'merged' || updated.length === 0) {
    return;
  }

  const originatingAssociation = updated.find(
    ({ createdByRoomote }) => createdByRoomote,
  );
  if (!originatingAssociation) {
    return;
  }

  const [originatingTask] = await db
    .select({ workflow: tasks.workflow, surface: tasks.surface })
    .from(tasks)
    .where(eq(tasks.id, originatingAssociation.taskId));

  if (
    !originatingTask ||
    originatingTask.workflow === 'pr_review' ||
    originatingTask.workflow === 'pr_conflict_resolve'
  ) {
    return;
  }

  void captureActivationPrMerged({
    provider,
    workflow: originatingTask.workflow,
    surface: originatingTask.surface,
  });
}
