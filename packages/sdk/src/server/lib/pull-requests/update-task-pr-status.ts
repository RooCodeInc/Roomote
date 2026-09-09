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
  requeueBrainMemoryEventsForTasks,
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

function normalizeHost(host: string | null | undefined): string | null {
  if (!host?.trim()) return null;
  try {
    const url = new URL(`https://${host.trim()}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** Update only associations bound to the event's source-control instance. */
export async function updateTaskPrStatus(
  provider: SourceControlProvider,
  repository: string,
  prNumber: number,
  status: PullRequestStatus,
  scope: { host: string | null | undefined; repositoryId?: string },
): Promise<void> {
  const host = normalizeHost(scope?.host);
  if (!host && !scope?.repositoryId) return;

  const matchingPullRequest = and(
    eq(taskPullRequests.sourceControlProvider, provider),
    eq(taskPullRequests.repository, repository),
    eq(taskPullRequests.prNumber, prNumber),
  );
  const { updated, originatingTaskId } = await db.transaction(async (tx) => {
    const candidates = await tx.query.taskPullRequests.findMany({
      where: matchingPullRequest,
      columns: { id: true, host: true, repositoryId: true, prUrl: true },
      with: { repository: { columns: { host: true } } },
    });
    const ids = candidates
      .filter((row) => {
        if (
          scope.repositoryId &&
          row.repositoryId &&
          row.repositoryId !== scope.repositoryId
        ) {
          return false;
        }
        // Legacy associations may predate host/repositoryId. Their persisted
        // repository or absolute PR URL can still identify the instance; an
        // unknown instance must never fall back to name/number-only matching.
        let rowHost = normalizeHost(row.host ?? row.repository?.host);
        if (row.host == null && row.repository?.host == null) {
          try {
            const url = new URL(row.prUrl);
            if (url.protocol === 'https:' || url.protocol === 'http:') {
              rowHost = normalizeHost(url.host);
            }
          } catch {
            // No usable persisted URL provenance.
          }
        }
        if (host && rowHost) return host === rowHost;
        return Boolean(
          scope.repositoryId && row.repositoryId === scope.repositoryId,
        );
      })
      .map((row) => row.id);
    if (ids.length === 0) return { updated: [], originatingTaskId: null };

    const scopedPullRequest = and(
      matchingPullRequest,
      inArray(taskPullRequests.id, ids),
    );
    // Replayed terminal statuses must not requeue the same memories again.
    const matchingStatus = and(
      scopedPullRequest,
      ...(status === 'merged' || status === 'closed'
        ? [
            or(
              isNull(taskPullRequests.status),
              ne(taskPullRequests.status, status),
            ),
          ]
        : []),
    );
    let originatingTaskId: string | null = null;
    if (status === 'merged') {
      const linkedTasks = await tx
        .select({
          taskId: taskPullRequests.taskId,
          createdByRoomote: taskPullRequests.createdByRoomote,
        })
        .from(taskPullRequests)
        .where(scopedPullRequest);

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

  if ((status === 'merged' || status === 'closed') && updated.length > 0) {
    // The task's memory pages were written at completion, before anyone knew
    // whether the work would ship. Re-ingest them so recall carries the
    // outcome. Best-effort: a Memory hiccup must not fail the webhook.
    const taskIds = [...new Set(updated.map((row) => row.taskId))].sort();
    try {
      await requeueBrainMemoryEventsForTasks(db, taskIds);
    } catch (error) {
      console.error(
        `[updateTaskPrStatus] Failed to requeue memories for ${taskIds.join(', ')} after ${status} PR:`,
        error,
      );
    }
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
