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

export async function snapshot({
  runId,
  environmentId,
  sandboxId,
}: SnapshotOptions): Promise<boolean> {
  setWorkerRuntimeContext({
    runId,
    taskRunType: TaskPayloadKind.SnapshotEnvironment,
    environmentId,
  });

  try {
    await sdk.taskRuns.update({
      id: runId,
      status: RunStatus.Preparing,
    });

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

    const workerEnv = WorkerEnv.fromProcessEnv(process.env);
    const startupLogger = createStartupLogger();

    // Write source-control tokens under ~/.roomote and set up shell env files
    // so file-backed credential helpers can authenticate git operations.
    await injectEnvVars(envVars, undefined, { sourceControlToken });

    const environmentConfig = await findRuntimeEnvironmentConfig(environmentId);
    const taskRun = await sdk.taskRuns.findFirstById(runId);

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

    await sdk.taskRuns.update({
      id: runId,
      status: RunStatus.Running,
    });

    // The provider snapshots the entire filesystem, so drop credential
    // material (env.sh exports, git tokens, OpenCode auth files) now that
    // setup is done. Task runs launched from the snapshot re-inject env vars
    // and tokens at startup.
    await scrubSandboxSecretsBeforeSnapshot();

    // Enqueue snapshot request via SDK.
    const { enqueued } = await sdk.taskRuns.createSnapshot({
      runId,
      sandboxId,
    });

    console.info(
      enqueued ? 'Snapshotting workspace' : 'Workspace already snapshotting',
    );

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

    await sdk.taskRuns.done({
      id: runId,
      status: RunStatus.Failed,
      error: message,
    });

    captureWorkerException(error, {
      runId,
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
