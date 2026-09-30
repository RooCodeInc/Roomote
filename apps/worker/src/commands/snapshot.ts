import pWaitFor from 'p-wait-for';

import {
  DEFAULT_SOURCE_CONTROL_PROVIDER,
  RunStatus,
  TaskPayloadKind,
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
import { resolveRepositoryProvidersFromPayload } from './utils/repository-providers';
import { scrubSandboxSecretsBeforeSnapshot } from './utils/scrub-sandbox-secrets';
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
  runId: number;
  environmentId: string;
  sandboxId: string;
}

type SnapshotFailureStage =
  | 'mark_preparing'
  | 'fetch_snapshot_environment'
  | 'initialize_worker_environment'
  | 'inject_environment'
  | 'load_environment'
  | 'load_task_run'
  | 'setup_environment'
  | 'mark_running'
  | 'scrub_secrets'
  | 'enqueue_snapshot'
  | 'poll_snapshot';

export async function snapshot({
  runId,
  environmentId,
  sandboxId,
}: SnapshotOptions): Promise<boolean> {
  let failureStage: SnapshotFailureStage = 'mark_preparing';

  setWorkerRuntimeContext({
    runId,
    taskRunType: TaskPayloadKind.SnapshotEnvironment,
    environmentId,
  });

  try {
    failureStage = 'mark_preparing';
    await sdk.taskRuns.update({
      id: runId,
      status: RunStatus.Preparing,
    });

    failureStage = 'fetch_snapshot_environment';
    const {
      envVars: fetchedEnvVars,
      gitHubToken: GH_TOKEN,
      sourceControlToken,
      taskId,
    } = await sdk.taskRuns.fetchSnapshotEnv({ runId });

    const envVars: Record<string, string> = {
      ...fetchedEnvVars,
      ...(sourceControlToken?.envVars ?? { GH_TOKEN }),
    };

    setWorkerRuntimeContext({
      runId,
      taskRunType: TaskPayloadKind.SnapshotEnvironment,
      environmentId,
      taskId,
    });

    failureStage = 'initialize_worker_environment';
    const workerEnv = WorkerEnv.fromProcessEnv(process.env);
    const startupLogger = createStartupLogger();

    // Write source-control tokens under ~/.roomote and set up shell env files
    // so file-backed credential helpers can authenticate git operations.
    failureStage = 'inject_environment';
    await injectEnvVars(envVars, undefined, { sourceControlToken });

    failureStage = 'load_environment';
    const environmentConfig = await findRuntimeEnvironmentConfig(environmentId);

    failureStage = 'load_task_run';
    const taskRun = await sdk.taskRuns.findFirstById(runId);

    if (!environmentConfig) {
      throw new Error(`Environment not found`);
    }

    failureStage = 'setup_environment';
    await setup({
      mode: 'full',
      workspace: {
        workspace: {
          type: 'environment',
          environmentId,
          environmentConfig,
        },
        envVars,
        taskRunType: TaskPayloadKind.SnapshotEnvironment,
        sourceControlProvider:
          sourceControlToken?.provider ?? DEFAULT_SOURCE_CONTROL_PROVIDER,
        repositoryProviders: resolveRepositoryProvidersFromPayload(
          taskRun?.payload,
        ),
      },
      logger: startupLogger,
      workerEnv,
    });

    failureStage = 'mark_running';
    await sdk.taskRuns.update({
      id: runId,
      status: RunStatus.Running,
    });

    // The provider snapshots the entire filesystem, so drop credential
    // material (env.sh exports, git tokens, OpenCode auth files) now that
    // setup is done. Task runs launched from the snapshot re-inject env vars
    // and tokens at startup.
    failureStage = 'scrub_secrets';
    await scrubSandboxSecretsBeforeSnapshot();

    // Enqueue snapshot request via SDK.
    failureStage = 'enqueue_snapshot';
    const { enqueued } = await sdk.taskRuns.createSnapshot({
      runId,
      sandboxId,
    });

    console.info(
      enqueued ? 'Snapshotting workspace' : 'Workspace already snapshotting',
    );

    failureStage = 'poll_snapshot';
    await pWaitFor(
      async () => {
        const updatedRun = await sdk.taskRuns.findRuntimeStateById(runId);

        // Explicitly check for undefined (job not found) vs null (snapshot not yet created).
        return (
          updatedRun !== undefined && updatedRun.snapshotCreatedAt !== null
        );
      },
      {
        interval: SNAPSHOT_POLL_INTERVAL_MS,
        timeout: EXPLICIT_SNAPSHOT_TIMEOUT_MS,
      },
    );

    console.info('Workspace snapshot completed');

    // Note that we call `sdk.taskRuns.done()` in the error case, but in the
    // success case the BullMQ job does this for us.
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnosticMessage = `Snapshot failed during ${failureStage}: ${message}`;

    try {
      await sdk.taskRuns.done({
        id: runId,
        status: RunStatus.Failed,
        error: diagnosticMessage,
      });
    } catch (doneError) {
      captureWorkerException(doneError, {
        runId,
        environmentId,
        stage: 'snapshot.finalize',
        snapshotFailureStage: failureStage,
      });

      console.error(
        `Failed to finalize snapshot failure during ${failureStage}: ${doneError instanceof Error ? doneError.message : String(doneError)}`,
      );
    }

    // Mark the environment snapshot as failed so the UI stops showing "Snapshotting..."
    try {
      await sdk.environments.updateSnapshotStatus({
        environmentId,
        snapshotStatus: 'failed',
      });
    } catch (envError) {
      captureWorkerException(envError, {
        runId,
        environmentId,
        stage: 'snapshot.updateSnapshotStatus',
        snapshotFailureStage: failureStage,
      });

      console.error(
        `Failed to update environment snapshot status: ${envError instanceof Error ? envError.message : String(envError)}`,
      );
    }

    captureWorkerException(error, {
      runId,
      environmentId,
      stage: `snapshot.${failureStage}`,
      snapshotFailureStage: failureStage,
    });

    console.error(
      `Caught error when preparing and snapshotting workspace during ${failureStage}: ${message}`,
    );

    return false;
  } finally {
    clearWorkerRuntimeContext();
  }
}
