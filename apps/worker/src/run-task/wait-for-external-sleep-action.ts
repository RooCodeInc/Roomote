import pWaitFor from 'p-wait-for';

import {
  isExitedCloudTaskStatus,
  isSleepCheckManagedComputeProvider,
  isSnapshotCapableComputeProvider,
  isResumableCloudTaskType,
} from '@roomote/types';
import { type DequeuedCloudJob, sdk } from '@roomote/sdk/client';

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
  cloudJob: DequeuedCloudJob['cloudJob'];
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
  cloudJob,
  logger,
}: WaitForExternalSleepActionOptions): Promise<SleepActionResult> {
  if (!isSleepCheckManagedComputeProvider(cloudJob.vendor)) {
    return { claimed: false, completed: false };
  }

  if (!cloudJob.machineId) {
    logger.warn(
      `[waitForExternalSleepAction] No machineId for job ${cloudJob.id}, skipping sleep handoff`,
    );

    return { claimed: false, completed: false };
  }

  // Non-snapshot providers (Daytona) exit via destroy, never via snapshot.
  const isResumable =
    isResumableCloudTaskType(cloudJob.type) &&
    isSnapshotCapableComputeProvider(cloudJob.vendor);
  let sleepRequested = false;

  try {
    logger.info(
      `[waitForExternalSleepAction] Waiting for BullMQ to claim sleep action for job ${cloudJob.id} (grace ${EXTERNAL_SLEEP_ACTION_REQUEST_GRACE_MS / 1000}s)`,
    );

    await pWaitFor(
      async () => {
        const updatedJob = await sdk.cloudJobs.findRuntimeStateById(
          cloudJob.id,
        );

        if (!updatedJob) {
          return false;
        }

        if (updatedJob.snapshotFailedAt) {
          throw new Error(
            updatedJob.error ??
              `Snapshot failed for job ${cloudJob.id} before completion`,
          );
        }

        sleepRequested =
          sleepRequested ||
          Boolean(updatedJob.sleepRequestedAt) ||
          Boolean(updatedJob.snapshotCreatedAt);

        return sleepRequested;
      },
      {
        interval: SNAPSHOT_POLL_INTERVAL_MS,
        timeout: EXTERNAL_SLEEP_ACTION_REQUEST_GRACE_MS,
      },
    );
  } catch (error) {
    logger.warn(
      `[waitForExternalSleepAction] Sleep handoff failed for job ${cloudJob.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return { claimed: false, completed: false };
  }

  logger.info(
    `[waitForExternalSleepAction] Sleep action observed for job ${cloudJob.id}; waiting for BullMQ to finish`,
  );

  try {
    await pWaitFor(
      async () => {
        const updatedJob = await sdk.cloudJobs.findRuntimeStateById(
          cloudJob.id,
        );

        if (!updatedJob) {
          return false;
        }

        if (updatedJob.snapshotFailedAt) {
          throw new Error(
            updatedJob.error ??
              `Snapshot failed for job ${cloudJob.id} before completion`,
          );
        }

        if (isResumable) {
          return Boolean(updatedJob.snapshotCreatedAt);
        }

        return isExitedCloudTaskStatus(updatedJob.status);
      },
      {
        interval: SNAPSHOT_POLL_INTERVAL_MS,
        timeout: AUTO_SNAPSHOT_TIMEOUT_MS,
      },
    );

    logger.info(
      `[waitForExternalSleepAction] Sleep action completed for job ${cloudJob.id}`,
    );

    return { claimed: true, completed: true };
  } catch (error) {
    logger.warn(
      `[waitForExternalSleepAction] Sleep action failed or timed out for job ${cloudJob.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { claimed: true, completed: false };
}
