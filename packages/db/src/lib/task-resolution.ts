import type {
  PullRequestStatus,
  RequestedWorkKind,
  TaskResolutionStatus,
} from '@roomote/types';
import { bootingRunStatuses, RunStatus } from '@roomote/types';
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { taskPullRequests, taskRuns, tasks } from '../schema';

export type TaskResolutionMutationOptions = {
  executor?: DatabaseOrTransaction;
  now?: Date;
};

/** Serializes task-scoped resolution reads before related child-row writes. */
export async function lockTaskResolution(
  taskId: string,
  options: TaskResolutionMutationOptions = {},
): Promise<void> {
  const executor = options.executor ?? db;
  await executor
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for('update');
}

export function isTaskResolutionEligible(input: {
  requestedWorkKind: RequestedWorkKind;
  hasLinkedPullRequests: boolean;
}): boolean {
  return (
    input.requestedWorkKind === 'plan' ||
    input.requestedWorkKind === 'implement' ||
    input.hasLinkedPullRequests
  );
}

export function deriveLinkedPullRequestResolution(
  statuses: readonly (PullRequestStatus | null)[],
): TaskResolutionStatus | null {
  if (
    statuses.length === 0 ||
    statuses.some(
      (status) => status === null || status === 'open' || status === 'draft',
    )
  ) {
    return null;
  }

  return statuses.every((status) => status === 'merged')
    ? 'acknowledged'
    : 'needs_follow_up';
}

/**
 * Opens a deliverable's acknowledgement lifecycle. The null-status guard keeps
 * repeated closeout/keepalive writes from overwriting an accepted result.
 */
export async function openTaskResolutionOnCloseout(
  taskId: string,
  options: TaskResolutionMutationOptions = {},
): Promise<boolean> {
  const executor = options.executor ?? db;
  const now = options.now ?? new Date();
  const linkedPullRequestExists = executor
    .select({ value: sql`1` })
    .from(taskPullRequests)
    .where(eq(taskPullRequests.taskId, tasks.id));

  const [opened] = await executor
    .update(tasks)
    .set({
      resolutionStatus: 'awaiting_confirmation',
      resolutionUpdatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        isNull(tasks.resolutionStatus),
        ne(tasks.state, 'failed'),
        ne(tasks.state, 'canceled'),
        or(
          isNull(tasks.goalStatus),
          and(
            ne(tasks.goalStatus, 'blocked'),
            ne(tasks.goalStatus, 'budget_limited'),
          ),
        ),
        or(
          inArray(tasks.requestedWorkKind, ['plan', 'implement']),
          exists(linkedPullRequestExists),
        ),
      ),
    )
    .returning({ id: tasks.id });

  if (!opened) {
    return false;
  }

  await resolveTaskResolutionFromLinkedPullRequests(taskId, {
    executor,
    now,
  });
  return true;
}

/** Clears any prior acceptance marker before a follow-up or working phase. */
export async function clearTaskResolution(
  taskId: string,
  options: TaskResolutionMutationOptions = {},
): Promise<boolean> {
  const executor = options.executor ?? db;
  const now = options.now ?? new Date();
  const [cleared] = await executor
    .update(tasks)
    .set({ resolutionStatus: null, resolutionUpdatedAt: now, updatedAt: now })
    .where(and(eq(tasks.id, taskId), isNotNull(tasks.resolutionStatus)))
    .returning({ id: tasks.id });

  return Boolean(cleared);
}

/** Explicitly accepts an actionable result; repeated calls are no-ops. */
export async function acknowledgeTaskResolution(
  taskId: string,
  options: TaskResolutionMutationOptions = {},
): Promise<boolean> {
  const executor = options.executor ?? db;
  const now = options.now ?? new Date();
  const latestRunIsExecuting = sql`EXISTS (
    SELECT 1
    FROM (
      SELECT ${taskRuns.status} AS status, ${taskRuns.taskPhase} AS task_phase
      FROM ${taskRuns}
      WHERE ${taskRuns.taskId} = ${tasks.id}
      ORDER BY ${taskRuns.id} DESC
      LIMIT 1
    ) AS latest_task_run
    WHERE latest_task_run.status IN (${sql.join(
      bootingRunStatuses.map((status) => sql`${status}`),
      sql`, `,
    )})
      OR (
        latest_task_run.status = ${RunStatus.Running}
        AND latest_task_run.task_phase IS NULL
      )
      OR (
        latest_task_run.status NOT IN (
          ${RunStatus.Completed}, ${RunStatus.Failed}, ${RunStatus.Canceled}
        )
        AND latest_task_run.task_phase = 'running'
      )
  )`;
  const [acknowledged] = await executor
    .update(tasks)
    .set({
      resolutionStatus: 'acknowledged',
      resolutionUpdatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(tasks.resolutionStatus, [
          'awaiting_confirmation',
          'needs_follow_up',
        ]),
        sql`NOT (${latestRunIsExecuting})`,
      ),
    )
    .returning({ id: tasks.id });

  return Boolean(acknowledged);
}

/**
 * Aggregates every linked PR and updates only tasks still awaiting acceptance.
 * Unknown/open statuses preserve the current awaiting state.
 */
export async function resolveTaskResolutionFromLinkedPullRequests(
  taskId: string,
  options: TaskResolutionMutationOptions = {},
): Promise<boolean> {
  const executor = options.executor ?? db;
  await lockTaskResolution(taskId, { executor });
  const statuses = await executor
    .select({ status: taskPullRequests.status })
    .from(taskPullRequests)
    .where(eq(taskPullRequests.taskId, taskId));
  const resolutionStatus = deriveLinkedPullRequestResolution(
    statuses.map(({ status }) => status),
  );

  if (resolutionStatus === null) {
    return false;
  }

  const now = options.now ?? new Date();
  const [resolved] = await executor
    .update(tasks)
    .set({ resolutionStatus, resolutionUpdatedAt: now, updatedAt: now })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.resolutionStatus, 'awaiting_confirmation'),
      ),
    )
    .returning({ id: tasks.id });

  return Boolean(resolved);
}
