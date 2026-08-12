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
  BOX_SNAPSHOT_NAME_PREFIX,
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

function getWorkerLaunchCommand(
  taskRun: TaskRun,
): 'snapshot' | 'resume' | 'run' {
  return taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment
    ? 'snapshot'
    : taskRun.payloadKind === TaskPayloadKind.SnapshotResume
      ? 'resume'
      : 'run';
}

function getWorkerLaunchArgs(taskRun: TaskRun, machineId: string): string[] {
  const command = getWorkerLaunchCommand(taskRun);

  return taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment
    ? [
        'snapshot',
        '--task-run-id',
        taskRun.id.toString(),
        '--environment-id',
        taskRun.payload.environmentId ?? '',
        '--sandbox-id',
        machineId,
      ]
    : [command, taskRun.id.toString()];
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
  const { namedPorts, environmentSnapshotId, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);

  let launchOptions:
    | { launchMode: 'fresh' }
    | { launchMode: 'environment_snapshot'; sourceSnapshotId: string }
    | { launchMode: 'task_snapshot'; sourceSnapshotId: string }
    | { launchMode: 'task_standby'; resumeHandle: string };

  if (taskRun.payloadKind === TaskPayloadKind.SnapshotResume) {
    const snapshotId = taskRun.sourceSnapshotId;
    if (!snapshotId) {
      throw new NonRetryableSpawnError(
        `SnapshotResume task run #${taskRun.id} missing sourceSnapshotId`,
      );
    }
    // A resume id is usually the archived box itself (standby); a
    // roomote-snap- name is a template to fork instead.
    launchOptions = snapshotId.startsWith(BOX_SNAPSHOT_NAME_PREFIX)
      ? { launchMode: 'task_snapshot', sourceSnapshotId: snapshotId }
      : { launchMode: 'task_standby', resumeHandle: snapshotId };
  } else if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
    // Environment snapshot runs prepare the sandbox fresh, then the worker
    // requests the named snapshot.
    launchOptions = { launchMode: 'fresh' };
  } else {
    const snapshotId =
      taskRun.sourceSnapshotId ?? environmentSnapshotId ?? undefined;
    launchOptions = snapshotId
      ? { launchMode: 'environment_snapshot', sourceSnapshotId: snapshotId }
      : { launchMode: 'fresh' };
  }

  if (
    taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment &&
    !taskRun.payload.environmentId
  ) {
    throw new NonRetryableSpawnError(
      `SnapshotEnvironment task run #${taskRun.id} missing environmentId in payload`,
    );
  }
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
      'resumeHandle' in launchOptions
        ? launchOptions.resumeHandle
        : 'sourceSnapshotId' in launchOptions
          ? launchOptions.sourceSnapshotId
          : null,
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
            : launchOptions.launchMode === 'environment_snapshot' ||
                launchOptions.launchMode === 'task_snapshot'
              ? 'Template-forked Box launch'
              : 'Fresh Box launch',
      });
    }

    const args = getWorkerLaunchArgs(taskRun, machine.machineId);
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
