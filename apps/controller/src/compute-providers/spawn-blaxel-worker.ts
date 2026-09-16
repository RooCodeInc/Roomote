import {
  NonRetryableSpawnError,
  TaskPayloadKind,
  getPrimaryPortFromConfig,
} from '@roomote/types';
import {
  type TaskRun,
  createComputeProviderMutationEventRecorder,
  db,
} from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';
import {
  buildBlaxelWorkerEnv,
  buildComputeProviderMutationDetails,
  createBlaxelMachine,
  createComputeProviderClient,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';

import { primeEnvironmentOidcForMachine } from '../sandbox-oidc';
import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';
import {
  prepareHostedWorkerLaunch,
  type CredentialEgressLifecycle,
} from '../credential-egress';
import { resolveTaskSandboxMemoryMiB } from './task-sandbox-resources';
import {
  COMPUTE_BOOTSTRAP_TIMEOUT_MS,
  COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
} from './timeouts';

export async function spawnBlaxelWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    blaxelApiKey: string;
    blaxelWorkspace: string;
    blaxelImage: string;
    blaxelRegion?: string;
    blaxelTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    blaxelTags?: Record<string, string>;
    /** Session-egress admission; omitted in unit paths that do not exercise it. */
    credentialEgress?: CredentialEgressLifecycle;
  },
): Promise<{ machineId: string; sandboxCmdId?: string }> {
  if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
    throw new NonRetryableSpawnError(
      'Blaxel does not support Roomote environment snapshots',
    );
  }

  let launchOptions:
    | { launchMode: 'fresh' }
    | { launchMode: 'task_standby'; resumeHandle: string };
  if (taskRun.payloadKind === TaskPayloadKind.SnapshotResume) {
    if (!taskRun.sourceSnapshotId) {
      throw new NonRetryableSpawnError(
        `SnapshotResume task run #${taskRun.id} missing sourceSnapshotId`,
      );
    }
    launchOptions = {
      launchMode: 'task_standby',
      resumeHandle: taskRun.sourceSnapshotId,
    };
  } else {
    launchOptions = { launchMode: 'fresh' };
  }

  const { namedPorts, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);
  const sandboxResources = await resolveTaskSandboxMemoryMiB(
    taskRun,
    environmentConfig,
  );
  const authBypassEnabled = shouldEnableAuthBypassForTaskRun({
    environmentConfig,
    namedPorts,
  });
  const authBypassValue = authBypassEnabled
    ? resolveAuthBypassValue(environmentConfig)
    : undefined;
  const authBypassHeaderName = authBypassEnabled
    ? resolveAuthBypassHeaderName(environmentConfig)
    : undefined;
  const environmentId = taskRun.payload.environmentId;
  const mutationContext = {
    launchMode: launchOptions.launchMode,
    sourceSnapshotId:
      'resumeHandle' in launchOptions ? launchOptions.resumeHandle : null,
    ports: namedPorts.map(({ port }) => port),
  };
  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    { runId: taskRun.id, taskId: taskRun.taskId },
    { logPrefix: 'spawnBlaxelWorker', logger: console },
  );
  const computeClient = createComputeProviderClient({
    provider: 'blaxel',
    config: {
      apiKey: config.blaxelApiKey,
      workspace: config.blaxelWorkspace,
      image: config.blaxelImage,
      region: config.blaxelRegion,
      timeoutMs: config.blaxelTimeoutMs,
      memoryMiB: sandboxResources.memoryMiB,
    },
  });

  await stampTaskRunMilestone({
    runId: taskRun.id,
    field: 'provisionStartedAt',
    launchMode: launchOptions.launchMode,
  });

  const launchHostedWorker = await prepareHostedWorkerLaunch({
    credentialEgress: config.credentialEgress,
    taskRun,
    provider: 'blaxel',
  });

  const machine = await createBlaxelMachine({
    blaxelApiKey: config.blaxelApiKey,
    blaxelWorkspace: config.blaxelWorkspace,
    blaxelImage: config.blaxelImage,
    idempotencyKey: `roomote-task-${taskRun.taskId}`,
    blaxelRegion: config.blaxelRegion,
    namedPorts,
    tags: config.blaxelTags,
    timeoutMs: config.blaxelTimeoutMs,
    localTarballPath: config.localTarballPath,
    createInstanceTimeoutMs: COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
    bootstrapTimeoutMs: COMPUTE_BOOTSTRAP_TIMEOUT_MS,
    computeClient,
    onMutation: recordMutation,
    ...launchOptions,
  });

  let launchedCommandId: string | undefined;
  try {
    await updateTaskRunMachine({
      taskRun,
      vendor: 'blaxel',
      machineId: machine.machineId,
      namedPorts,
      domainFn: machine.domain,
      proxyPorts: machine.proxyPorts,
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sourceSnapshotId: machine.sourceSnapshotId ?? null,
      authBypassValue,
      authBypassHeaderName,
      configuredMemoryMiB: sandboxResources.memoryMiB,
    });
    await stampTaskRunMilestone({
      runId: taskRun.id,
      field: 'provisionReadyAt',
    });
    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: taskRun.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'blaxel',
        computeProviderId: machine.machineId,
        runId: taskRun.id,
        context:
          launchOptions.launchMode === 'task_standby'
            ? 'Standby-resumed Blaxel launch'
            : 'Fresh Blaxel launch',
      });
    }

    const workerCommand =
      taskRun.payloadKind === TaskPayloadKind.SnapshotResume ? 'resume' : 'run';
    const args = [workerCommand, taskRun.id.toString()];
    await recordMutation({
      provider: 'blaxel',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Launching detached worker for Blaxel sandbox ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
      }),
    });
    const result = await launchHostedWorker(
      buildBlaxelWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + config.blaxelTimeoutMs,
        deploymentSlug: config.deploymentSlug,
        environmentId,
        image: config.blaxelImage,
        extraEnv: {
          SANDBOX_TIMEOUT_MS: String(config.blaxelTimeoutMs),
        },
      }),
      async (env) => {
        const launchResult = await computeClient.runCommand({
          instanceId: machine.machineId,
          cmd: 'worker',
          args,
          env,
          detached: true,
          signal: AbortSignal.timeout(60_000),
        });
        launchedCommandId = launchResult.commandId;
        if (launchResult.exitCode !== null && launchResult.exitCode !== 0) {
          throw new Error(
            `Detached Blaxel worker exited with code ${launchResult.exitCode}: ${launchResult.stderr ?? launchResult.stdout ?? 'no output'}`,
          );
        }
        await recordMutation({
          provider: 'blaxel',
          operation: 'run_command',
          eventType: 'completed',
          instanceId: machine.machineId,
          message: `Detached worker launched for Blaxel sandbox ${machine.machineId}.`,
          details: buildComputeProviderMutationDetails(mutationContext, {
            commandId: launchResult.commandId ?? null,
            exitCode: launchResult.exitCode,
          }),
        });
        return launchResult;
      },
    );

    return {
      machineId: machine.machineId,
      ...(result.commandId ? { sandboxCmdId: result.commandId } : {}),
    };
  } catch (error) {
    if (launchOptions.launchMode === 'task_standby') {
      // This is the only copy of the task's mutable state. Preserve it for a
      // controller retry instead of applying the fresh-launch cleanup rule.
      await computeClient
        .enterStandby?.({
          instanceId: machine.machineId,
          commandId: launchedCommandId,
        })
        .catch((cleanupError) => {
          console.error(
            '[spawnBlaxelWorker] Failed to restore standby after resume failure',
            cleanupError,
          );
        });
    } else {
      await computeClient
        .destroyInstance({ instanceId: machine.machineId })
        .catch((cleanupError) => {
          console.error('[spawnBlaxelWorker] Cleanup failed', cleanupError);
        });
    }
    throw error;
  }
}
