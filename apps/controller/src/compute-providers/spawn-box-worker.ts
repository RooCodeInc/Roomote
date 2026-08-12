import {
  NonRetryableSpawnError,
  TaskPayloadKind,
  getPrimaryPortFromConfig,
} from '@roomote/types';
import {
  type TaskRun,
  createComputeProviderMutationEventRecorder,
  db,
  eq,
  taskRuns,
} from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';
import {
  buildBoxWorkerEnv,
  buildComputeProviderMutationDetails,
  createBoxMachine,
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
import { resolveTaskSandboxMemoryMiB } from './task-sandbox-resources';
import { COMPUTE_BOOTSTRAP_TIMEOUT_MS } from './timeouts';

type BoxMachineType = 'small' | 'default' | 'large';

const BOX_MEMORY_MIB: Record<BoxMachineType, number> = {
  small: 4 * 1024,
  default: 8 * 1024,
  large: 16 * 1024,
};

export function resolveBoxMachineType(
  requiredMemoryMiB: number,
  configuredType?: BoxMachineType,
): BoxMachineType {
  const configuredMemoryMiB = configuredType
    ? BOX_MEMORY_MIB[configuredType]
    : 0;
  const minimumMemoryMiB = Math.max(requiredMemoryMiB, configuredMemoryMiB);
  const resolved = (['small', 'default', 'large'] as const).find(
    (type) => BOX_MEMORY_MIB[type] >= minimumMemoryMiB,
  );

  if (!resolved) {
    throw new NonRetryableSpawnError(
      `Box supports at most 16384 MiB, but this task requires ${requiredMemoryMiB} MiB`,
    );
  }

  return resolved;
}

export async function spawnBoxWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    boxApiKey: string;
    boxApiBaseUrl?: string;
    boxMachineType?: BoxMachineType;
    boxTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
  },
): Promise<{ machineId: string; sandboxCmdId?: string }> {
  if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
    throw new NonRetryableSpawnError(
      'Box does not support Roomote environment snapshots',
    );
  }

  const launchOptions =
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume
      ? taskRun.sourceSnapshotId
        ? ({
            launchMode: 'task_standby',
            resumeHandle: taskRun.sourceSnapshotId,
          } as const)
        : (() => {
            throw new NonRetryableSpawnError(
              `SnapshotResume task run #${taskRun.id} missing sourceSnapshotId`,
            );
          })()
      : ({ launchMode: 'fresh' } as const);

  const { namedPorts, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);
  const sandboxResources = await resolveTaskSandboxMemoryMiB(
    taskRun,
    environmentConfig,
  );
  const machineType = resolveBoxMachineType(
    sandboxResources.memoryMiB,
    config.boxMachineType,
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
    { logPrefix: 'spawnBoxWorker', logger: console },
  );
  const computeClient = createComputeProviderClient({
    provider: 'box',
    config: {
      apiKey: config.boxApiKey,
      boxApiBaseUrl: config.boxApiBaseUrl,
      machineType,
      timeoutMs: config.boxTimeoutMs,
    },
  });

  await stampTaskRunMilestone({
    runId: taskRun.id,
    field: 'provisionStartedAt',
    launchMode: launchOptions.launchMode,
  });
  const machine = await createBoxMachine({
    boxApiKey: config.boxApiKey,
    boxApiBaseUrl: config.boxApiBaseUrl,
    timeoutMs: config.boxTimeoutMs,
    machineType,
    idempotencyKey: `roomote-task-${taskRun.taskId}`,
    namedPorts,
    localTarballPath: config.localTarballPath,
    bootstrapTimeoutMs: COMPUTE_BOOTSTRAP_TIMEOUT_MS,
    computeClient,
    onMutation: recordMutation,
    ...launchOptions,
  });

  let launchedCommandId: string | undefined;
  try {
    await updateTaskRunMachine({
      taskRun,
      vendor: 'box',
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
      configuredMemoryMiB: BOX_MEMORY_MIB[machineType],
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
        computeProvider: 'box',
        computeProviderId: machine.machineId,
        runId: taskRun.id,
        context:
          launchOptions.launchMode === 'task_standby'
            ? 'Standby-resumed Box launch'
            : 'Fresh Box launch',
      });
    }

    const workerCommand =
      taskRun.payloadKind === TaskPayloadKind.SnapshotResume ? 'resume' : 'run';
    const args = [workerCommand, taskRun.id.toString()];
    await recordMutation({
      provider: 'box',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Launching detached worker for Box ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
      }),
    });
    const result = await computeClient.runCommand({
      instanceId: machine.machineId,
      cmd: 'worker',
      args,
      env: buildBoxWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + config.boxTimeoutMs,
        deploymentSlug: config.deploymentSlug,
        environmentId,
        machineType,
        extraEnv: { SANDBOX_TIMEOUT_MS: String(config.boxTimeoutMs) },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });
    launchedCommandId = result.commandId;
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(
        `Detached Box worker exited with code ${result.exitCode}`,
      );
    }
    await recordMutation({
      provider: 'box',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `Detached worker launched for Box ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        commandId: result.commandId ?? null,
        exitCode: result.exitCode,
      }),
    });
    if (result.commandId) {
      await db
        .update(taskRuns)
        .set({ sandboxCmdId: result.commandId })
        .where(eq(taskRuns.id, taskRun.id));
    }
    return {
      machineId: machine.machineId,
      ...(result.commandId ? { sandboxCmdId: result.commandId } : {}),
    };
  } catch (error) {
    if (launchOptions.launchMode === 'task_standby') {
      await computeClient
        .enterStandby?.({
          instanceId: machine.machineId,
          commandId: launchedCommandId,
        })
        .catch((cleanupError) => {
          console.error(
            '[spawnBoxWorker] Failed to restore standby after resume failure',
            cleanupError,
          );
        });
    } else {
      await computeClient
        .destroyInstance({ instanceId: machine.machineId })
        .catch((cleanupError) => {
          console.error('[spawnBoxWorker] Cleanup failed', cleanupError);
        });
    }
    throw error;
  }
}
