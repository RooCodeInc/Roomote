import pWaitFor from 'p-wait-for';

import {
  isExitedRunStatus,
  isSleepCheckManagedComputeProvider,
  isTaskResumeCapableComputeProvider,
  isResumableTaskPayloadKind,
} from '@roomote/types';
import { type DequeuedTaskRun, sdk } from '@roomote/sdk/client';

import type { HarnessLogger } from '../logging';
import {
  AUTO_SNAPSHOT_TIMEOUT_MS,
  SNAPSHOT_POLL_INTERVAL_MS,
} from '../commands/snapshot';

/**
 * Maximum time to wait for BullMQ to notice that the authoritative sleep
 * deadline has elapsed and claim the job's sleep action.
 */
const EXTERNAL_SLEEP_ACTION_REQUEST_GRACE_MS = 60 * 1_000;

interface WaitForExternalSleepActionOptions {
  taskRun: DequeuedTaskRun['taskRun'];
  logger: HarnessLogger;
}

interface SleepActionResult {
  /** Whether BullMQ claimed the sleep action (set sleepRequestedAt). */
  claimed: boolean;
  /** Whether the sleep action completed (snapshot created or job exited). */
  completed: boolean;
}

/**
 * Wait for BullMQ to pick up the due sleep action after the worker's local
 * sleep timer has expired.
 *
 * This helper never enqueues work itself. Its only job is to keep the sandbox
 * alive long enough for the external scheduler to observe the due `sleepAt`
 * deadline and either request a snapshot or destroy the sandbox.
 */
export async function waitForExternalSleepAction({
  taskRun,
  logger,
}: WaitForExternalSleepActionOptions): Promise<SleepActionResult> {
  if (!isSleepCheckManagedComputeProvider(taskRun.vendor)) {
    return { claimed: false, completed: false };
  }

  if (!taskRun.machineId) {
    logger.warn(
      `[waitForExternalSleepAction] No machineId for job ${taskRun.id}, skipping sleep handoff`,
    );

    return { claimed: false, completed: false };
  }

  // Resumable providers complete via either an immutable snapshot or a
  // provider-native standby handle. Other providers exit via destroy.
  const isResumable =
    isResumableTaskPayloadKind(taskRun.payloadKind) &&
    isTaskResumeCapableComputeProvider(taskRun.vendor);
  let sleepRequested = false;

  try {
    logger.info(
      `[waitForExternalSleepAction] Waiting for BullMQ to claim sleep action for job ${taskRun.id} (grace ${EXTERNAL_SLEEP_ACTION_REQUEST_GRACE_MS / 1000}s)`,
    );

    await pWaitFor(
      async () => {
        const updatedRun = await sdk.taskRuns.findRuntimeStateById(taskRun.id);

        if (!updatedRun) {
          return false;
        }

        if (updatedRun.snapshotFailedAt) {
          throw new Error(
            updatedRun.error ??
              `Snapshot failed for job ${taskRun.id} before completion`,
          );
        }

        sleepRequested =
          sleepRequested ||
          Boolean(updatedRun.sleepRequestedAt) ||
          Boolean(updatedRun.snapshotCreatedAt);

        return sleepRequested;
      },
      {
        interval: SNAPSHOT_POLL_INTERVAL_MS,
        timeout: EXTERNAL_SLEEP_ACTION_REQUEST_GRACE_MS,
      },
    );
  } catch (error) {
    logger.warn(
      `[waitForExternalSleepAction] Sleep handoff failed for job ${taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return { claimed: false, completed: false };
  }

  logger.info(
    `[waitForExternalSleepAction] Sleep action observed for job ${taskRun.id}; waiting for BullMQ to finish`,
  );

  try {
    await pWaitFor(
      async () => {
        const updatedRun = await sdk.taskRuns.findRuntimeStateById(taskRun.id);

        if (!updatedRun) {
          return false;
        }

        if (updatedRun.snapshotFailedAt) {
          throw new Error(
            updatedRun.error ??
              `Snapshot failed for job ${taskRun.id} before completion`,
          );
        }

        if (isResumable) {
          return Boolean(updatedRun.snapshotCreatedAt);
        }

        return isExitedRunStatus(updatedRun.status);
      },
      {
        interval: SNAPSHOT_POLL_INTERVAL_MS,
        timeout: AUTO_SNAPSHOT_TIMEOUT_MS,
      },
    );

    logger.info(
      `[waitForExternalSleepAction] Sleep action completed for job ${taskRun.id}`,
    );

    return { claimed: true, completed: true };
  } catch (error) {
    logger.warn(
      `[waitForExternalSleepAction] Sleep action failed or timed out for job ${taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { claimed: true, completed: false };
}
