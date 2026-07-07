import pWaitFor from 'p-wait-for';

import {
  DEFAULT_SOURCE_CONTROL_PROVIDER,
  CloudTaskStatus,
  CloudTaskType,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';

import { WorkerEnv } from '../env';
import { createStartupLogger } from '../logging';
import { captureWorkerException } from '../monitoring/sentry';
import {
  clearWorkerRuntimeContext,
  setWorkerRuntimeContext,
} from '../monitoring/runtime-context';

import { setup } from './setup';
import { injectEnvVars } from './utils/env-vars';
import { findRuntimeEnvironmentConfig } from './utils/workspace-config';

/**
 * Shared completion timeout used by the external sleep handoff path while it
 * waits for BullMQ to finish a claimed sleep action.
 */
export const AUTO_SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1_000;

/** Maximum time (ms) to wait for the explicit snapshot command to complete. */
export const EXPLICIT_SNAPSHOT_TIMEOUT_MS = 10 * 60 * 1_000;

/** Interval (ms) between polling for snapshot completion. */
export const SNAPSHOT_POLL_INTERVAL_MS = 2_000;

interface SnapshotOptions {
  cloudJobId: number;
  environmentId: string;
  sandboxId: string;
}

export async function snapshot({
  cloudJobId,
  environmentId,
  sandboxId,
}: SnapshotOptions): Promise<boolean> {
  setWorkerRuntimeContext({
    cloudJobId,
    cloudJobType: CloudTaskType.SnapshotEnvironment,
    environmentId,
  });

  try {
    await sdk.cloudJobs.update({
      id: cloudJobId,
      status: CloudTaskStatus.Preparing,
    });

    const {
      envVars: fetchedEnvVars,
      gitHubToken: GH_TOKEN,
      sourceControlToken,
      taskId,
    } = await sdk.cloudJobs.fetchSnapshotEnv({ cloudJobId });

    const envVars: Record<string, string> = {
      ...fetchedEnvVars,
      ...(sourceControlToken?.envVars ?? { GH_TOKEN }),
    };

    setWorkerRuntimeContext({
      cloudJobId,
      cloudJobType: CloudTaskType.SnapshotEnvironment,
      environmentId,
      taskId,
    });

    const workerEnv = WorkerEnv.fromProcessEnv(process.env);
    const startupLogger = createStartupLogger();

    // Write source-control tokens under ~/.roomote and set up shell env files
    // so file-backed credential helpers can authenticate git operations.
    await injectEnvVars(envVars, undefined, { sourceControlToken });

    const environmentConfig = await findRuntimeEnvironmentConfig(environmentId);

    if (!environmentConfig) {
      throw new Error(`Environment not found`);
    }

    await setup({
      mode: 'full',
      workspace: {
        workspace: {
          type: 'environment',
          environmentId,
          environmentConfig,
        },
        envVars,
        cloudJobType: CloudTaskType.SnapshotEnvironment,
        sourceControlProvider:
          sourceControlToken?.provider ?? DEFAULT_SOURCE_CONTROL_PROVIDER,
      },
      logger: startupLogger,
      workerEnv,
    });

    await sdk.cloudJobs.update({
      id: cloudJobId,
      status: CloudTaskStatus.Running,
    });

    // Enqueue snapshot request via SDK.
    const { enqueued } = await sdk.cloudJobs.createSnapshot({
      cloudJobId,
      sandboxId,
    });

    console.info(
      enqueued ? 'Snapshotting workspace' : 'Workspace already snapshotting',
    );

    await pWaitFor(
      async () => {
        const updatedJob = await sdk.cloudJobs.findRuntimeStateById(cloudJobId);

        // Explicitly check for undefined (job not found) vs null (snapshot not yet created).
        return (
          updatedJob !== undefined && updatedJob.snapshotCreatedAt !== null
        );
      },
      {
        interval: SNAPSHOT_POLL_INTERVAL_MS,
        timeout: EXPLICIT_SNAPSHOT_TIMEOUT_MS,
      },
    );

    console.info('Workspace snapshot completed');

    // Note that we call `sdk.cloudJobs.done()` in the error case, but in the
    // success case the BullMQ job does this for us.
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await sdk.cloudJobs.done({
      id: cloudJobId,
      status: CloudTaskStatus.Failed,
      error: message,
    });

    // Mark the environment snapshot as failed so the UI stops showing "Snapshotting..."
    try {
      await sdk.environments.updateSnapshotStatus({
        environmentId,
        snapshotStatus: 'failed',
      });
    } catch (envError) {
      captureWorkerException(envError, {
        cloudJobId,
        environmentId,
        stage: 'snapshot.updateSnapshotStatus',
      });

      console.error(
        `Failed to update environment snapshot status: ${envError instanceof Error ? envError.message : String(envError)}`,
      );
    }

    captureWorkerException(error, {
      cloudJobId,
      environmentId,
      stage: 'snapshot',
    });

    console.error(
      `Caught error when preparing and snapshotting workspace: ${message}`,
    );

    return false;
  } finally {
    clearWorkerRuntimeContext();
  }
}
