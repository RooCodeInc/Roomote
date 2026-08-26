import {
  db,
  taskPullRequests,
  tasks,
  and,
  eq,
  isNull,
  lockTaskResolution,
  ne,
  or,
  resolveTaskResolutionFromLinkedPullRequests,
  syncTaskStateFromRuns,
} from '@roomote/db/server';
import { captureActivationPrMerged } from '@roomote/telemetry/server';
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
  const matchingPullRequest = and(
    eq(taskPullRequests.sourceControlProvider, provider),
    eq(taskPullRequests.repository, repository),
    eq(taskPullRequests.prNumber, prNumber),
  );
  const matchingStatus = and(
    matchingPullRequest,
    or(isNull(taskPullRequests.status), ne(taskPullRequests.status, 'merged')),
  );

  const updated = await db.transaction(async (tx) => {
    const linkedTasks = await tx
      .select({ taskId: taskPullRequests.taskId })
      .from(taskPullRequests)
      .where(matchingPullRequest);
    const linkedTaskIds = [
      ...new Set(linkedTasks.map((row) => row.taskId)),
    ].sort();

    for (const taskId of linkedTaskIds) {
      // Lock tasks in stable order before PR rows. This serializes aggregate
      // resolution and matches enqueue's task-before-PR lock order.
      await lockTaskResolution(taskId, { executor: tx });
      if (status === 'merged') {
        // Idle/running siblings still derive active, so legitimate follow-up
        // tasks stay open.
        await syncTaskStateFromRuns(tx, taskId);
      }
    }

    const updatedRows = await tx
      .update(taskPullRequests)
      .set({ status, updatedAt: new Date() })
      .where(matchingStatus)
      .returning({
        taskId: taskPullRequests.taskId,
        createdByRoomote: taskPullRequests.createdByRoomote,
      });

    for (const taskId of linkedTaskIds) {
      await resolveTaskResolutionFromLinkedPullRequests(taskId, {
        executor: tx,
      });
    }

    return updatedRows;
  });

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
