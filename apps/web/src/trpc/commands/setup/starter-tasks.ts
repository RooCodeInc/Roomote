import {
  and,
  db,
  desc,
  environments,
  eq,
  isNull,
  sql,
  taskRuns,
} from '@roomote/db/server';
import { ALL_REPOSITORIES } from '@roomote/types';
import { captureEvent } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';
import {
  getSetupStarterTask,
  type SetupStarterTaskId,
} from '@/lib/setup-starter-tasks';
import { createStandardTaskRunCommand } from '../task-runs';
import { completeSetupCommand } from './index';
import { assertAdmin } from './shared';

type CompleteSetupWithStarterTasksResult = {
  launched: Array<{ starterTaskId: SetupStarterTaskId; taskId: string }>;
  failed: Array<{ starterTaskId: SetupStarterTaskId; error: string }>;
  setupCompleted: boolean;
  completionError: string | null;
};

/**
 * Picks the launch workspace for setup starter tasks: the most recently
 * updated deployment environment when one exists (matching the ordering the
 * web environments list uses), otherwise the tasks fall back to the
 * ALL_REPOSITORIES workspace.
 */
async function findStarterTaskEnvironmentId(): Promise<string | null> {
  const [environment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(isNull(environments.userId), eq(environments.isEval, false)))
    .orderBy(desc(environments.updatedAt))
    .limit(1);

  return environment?.id ?? null;
}

async function findStarterTaskLaunch(
  launchIdempotencyKey: string,
): Promise<string | null> {
  const [existingRun] = await db
    .select({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .where(
      sql`${taskRuns.payload}->>'launchIdempotencyKey' = ${launchIdempotencyKey}`,
    )
    .limit(1);

  return existingRun?.taskId ?? null;
}

/**
 * Launches the selected setup starter tasks as direct standard web tasks and
 * completes setup once every requested launch succeeded.
 *
 * Each launch carries a stable key derived from the browser-session batch and
 * starter-task id. A partial unique index on task_runs makes concurrent retries
 * mutually exclusive, while the lookup before and after create recovers the
 * original task after a lost response or uniqueness race. An empty selection
 * simply completes setup, and setup stays incomplete while any requested launch
 * is still failing.
 */
export async function completeSetupWithStarterTasksCommand(
  auth: UserAuthSuccess,
  input: {
    launchBatchId: string;
    selectedStarterTaskIds: SetupStarterTaskId[];
    anonymousAnalyticsEnabled?: boolean;
    productUpdatesEnabled?: boolean;
  },
): Promise<CompleteSetupWithStarterTasksResult> {
  assertAdmin(auth);

  type StarterTaskLaunchOutcome =
    | { starterTaskId: SetupStarterTaskId; taskId: string }
    | { starterTaskId: SetupStarterTaskId; error: string };

  const selectedStarterTaskIds = [...new Set(input.selectedStarterTaskIds)];
  const environmentId =
    selectedStarterTaskIds.length > 0
      ? await findStarterTaskEnvironmentId()
      : null;

  const outcomes = await Promise.all(
    selectedStarterTaskIds.map(
      async (starterTaskId): Promise<StarterTaskLaunchOutcome> => {
        const starterTask = getSetupStarterTask(starterTaskId);
        const launchIdempotencyKey = [
          'setup-starter',
          auth.userId,
          input.launchBatchId,
          starterTaskId,
        ].join(':');

        try {
          const existingTaskId =
            await findStarterTaskLaunch(launchIdempotencyKey);
          if (existingTaskId) {
            return { starterTaskId, taskId: existingTaskId };
          }

          const result = await createStandardTaskRunCommand(auth, {
            payload: {
              repo: ALL_REPOSITORIES,
              ...(environmentId ? { environmentId } : {}),
              description: starterTask.prompt,
              launchIdempotencyKey,
            },
          });

          if (result.success) {
            return { starterTaskId, taskId: result.taskId };
          }

          // A concurrent request can win the unique-index race after our first
          // lookup. Recover its task instead of surfacing a retry that would
          // otherwise remain ambiguous.
          const concurrentlyLaunchedTaskId =
            await findStarterTaskLaunch(launchIdempotencyKey);
          return concurrentlyLaunchedTaskId
            ? { starterTaskId, taskId: concurrentlyLaunchedTaskId }
            : { starterTaskId, error: result.error };
        } catch (error) {
          const concurrentlyLaunchedTaskId =
            await findStarterTaskLaunch(launchIdempotencyKey);
          if (concurrentlyLaunchedTaskId) {
            return { starterTaskId, taskId: concurrentlyLaunchedTaskId };
          }

          return {
            starterTaskId,
            error:
              error instanceof Error
                ? error.message
                : 'The task could not be started.',
          };
        }
      },
    ),
  );

  const launched: CompleteSetupWithStarterTasksResult['launched'] = [];
  const failed: CompleteSetupWithStarterTasksResult['failed'] = [];

  for (const outcome of outcomes) {
    if ('taskId' in outcome) {
      launched.push(outcome);
    } else {
      failed.push(outcome);
    }
  }

  let setupCompleted = false;
  let completionError: string | null = null;

  if (failed.length === 0) {
    try {
      await completeSetupCommand(auth, {
        ...(input.anonymousAnalyticsEnabled === undefined
          ? {}
          : { anonymousAnalyticsEnabled: input.anonymousAnalyticsEnabled }),
        ...(input.productUpdatesEnabled === undefined
          ? {}
          : { productUpdatesEnabled: input.productUpdatesEnabled }),
      });
      setupCompleted = true;
    } catch (error) {
      completionError =
        error instanceof Error
          ? error.message
          : 'Setup could not be completed.';
    }
  }

  // Anonymous analytics: fixed catalog ids and counts only, never prompt text.
  void captureEvent('setup_starter_tasks_submitted', {
    userId: auth.userId,
    properties: {
      selectedCount: selectedStarterTaskIds.length,
      launchedCount: launched.length,
      failedCount: failed.length,
      starterTaskIds: selectedStarterTaskIds.join(','),
    },
  });

  return { launched, failed, setupCompleted, completionError };
}
