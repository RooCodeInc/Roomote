import {
  TaskPayloadKind,
  NonRetryableSpawnError,
  getPrimaryPortFromConfig,
} from '@roomote/types';
import {
  type TaskRun,
  createComputeProviderMutationEventRecorder,
  db,
  taskRuns,
  eq,
} from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';
import {
  buildComputeProviderMutationDetails,
  buildDaytonaWorkerEnv,
  cleanupDaytonaInstance,
  createComputeProviderClient,
  createDaytonaMachine,
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
import {
  COMPUTE_BOOTSTRAP_TIMEOUT_MS,
  COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
} from './timeouts';

const DAYTONA_LAUNCH_OUTPUT_TEXT_LIMIT = 500;

class DetachedWorkerLaunchError extends Error {
  public readonly details: Record<string, unknown>;

  public constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'DetachedWorkerLaunchError';
    this.details = details;
  }
}

function truncateLaunchOutput(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > DAYTONA_LAUNCH_OUTPUT_TEXT_LIMIT
    ? `${trimmed.slice(0, DAYTONA_LAUNCH_OUTPUT_TEXT_LIMIT)}...`
    : trimmed;
}

function buildDetachedWorkerExitError(
  command: string,
  result: {
    exitCode: number | null;
    commandId?: string;
    stdout?: string;
    stderr?: string;
  },
): DetachedWorkerLaunchError {
  const stdout = truncateLaunchOutput(result.stdout);
  const stderr = truncateLaunchOutput(result.stderr);
  const message = `Detached "worker ${command}" exited immediately with code ${result.exitCode}`;

  return new DetachedWorkerLaunchError(message, {
    commandId: result.commandId ?? null,
    exitCode: result.exitCode,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  });
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

export async function spawnDaytonaWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    daytonaApiKey: string;
    daytonaApiUrl?: string;
    daytonaTarget?: string;
    daytonaSnapshotName: string;
    daytonaTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    daytonaTags?: Record<string, string>;
  },
): Promise<{
  machineId: string;
  sandboxCmdId?: string;
}> {
  const {
    daytonaApiKey,
    daytonaApiUrl,
    daytonaTarget,
    daytonaSnapshotName,
    daytonaTimeoutMs,
    localTarballPath,
    deploymentSlug,
    daytonaTags,
  } = config;

  const environmentId = taskRun.payload.environmentId;

  const { namedPorts, environmentSnapshotId, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);
  const sandboxResources = await resolveTaskSandboxMemoryMiB(
    taskRun,
    environmentConfig,
  );

  const shouldEnableAuthBypass = shouldEnableAuthBypassForTaskRun({
    environmentConfig,
    namedPorts,
  });

  const authBypassValue = shouldEnableAuthBypass
    ? resolveAuthBypassValue(environmentConfig)
    : undefined;

  const authBypassHeaderName = shouldEnableAuthBypass
    ? resolveAuthBypassHeaderName(environmentConfig)
    : undefined;

  let launchOptions:
    | { launchMode: 'fresh' }
    | { launchMode: 'environment_snapshot'; sourceSnapshotId: string }
    | { launchMode: 'task_snapshot'; sourceSnapshotId: string };

  if (taskRun.payloadKind === TaskPayloadKind.SnapshotResume) {
    const snapshotId = taskRun.sourceSnapshotId;

    if (!snapshotId) {
      throw new NonRetryableSpawnError(
        `SnapshotResume task run #${taskRun.id} missing sourceSnapshotId`,
      );
    }

    launchOptions = {
      launchMode: 'task_snapshot',
      sourceSnapshotId: snapshotId,
    };
  } else if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
    // Environment snapshot refreshes must rebuild from the configured base
    // worker snapshot instead of inheriting the previous environment snapshot.
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
    throw new Error(
      `SnapshotEnvironment task run #${taskRun.id} missing environmentId in payload`,
    );
  }

  console.log(
    `[spawnDaytonaWorker] Creating Daytona instance for task run #${taskRun.id}... ${JSON.stringify(
      {
        ...launchOptions,
        namedPorts: namedPorts.map((p) => p.name),
      },
    )}`,
  );

  const createMachineStart = Date.now();

  const mutationContext = {
    launchMode: launchOptions.launchMode,
    sourceSnapshotId:
      'sourceSnapshotId' in launchOptions
        ? launchOptions.sourceSnapshotId
        : null,
    ports: namedPorts.map(({ port }) => port),
  } as const;

  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    {
      runId: taskRun.id,
      taskId: taskRun.taskId,
    },
    { logPrefix: 'spawnDaytonaWorker', logger: console },
  );

  const computeClient = createComputeProviderClient({
    provider: 'daytona',
    config: {
      apiKey: daytonaApiKey,
      snapshotName: daytonaSnapshotName,
      ...(daytonaApiUrl ? { apiUrl: daytonaApiUrl } : {}),
      ...(daytonaTarget ? { target: daytonaTarget } : {}),
      memoryGiB: sandboxResources.memoryMiB / 1024,
      timeoutMs: daytonaTimeoutMs,
    },
  });

  // Stamp provisionStartedAt + launchMode before the Daytona API call. Only-if-
  // null semantics preserve the earliest provision timestamp.
  await stampTaskRunMilestone({
    runId: taskRun.id,
    field: 'provisionStartedAt',
    launchMode: launchOptions.launchMode,
  }).catch((error) => {
    console.warn(
      `[spawnDaytonaWorker] Failed to stamp provisionStartedAt for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const machine = await createDaytonaMachine({
    daytonaApiKey,
    daytonaApiUrl,
    daytonaTarget,
    daytonaSnapshotName,
    namedPorts,
    tags: daytonaTags,
    timeoutMs: daytonaTimeoutMs,
    localTarballPath,
    createInstanceTimeoutMs: COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
    bootstrapTimeoutMs: COMPUTE_BOOTSTRAP_TIMEOUT_MS,
    computeClient,
    onMutation: recordMutation,
    ...launchOptions,
  });

  const workerCommand = getWorkerLaunchCommand(taskRun);
  const args = getWorkerLaunchArgs(taskRun, machine.machineId);

  try {
    await updateTaskRunMachine({
      taskRun,
      vendor: 'daytona',
      machineId: machine.machineId,
      namedPorts,
      domainFn: (port) => machine.domain(port),
      proxyPorts: machine.proxyPorts ?? {},
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sourceSnapshotId: mutationContext.sourceSnapshotId,
      authBypassValue,
      authBypassHeaderName,
      configuredMemoryMiB: sandboxResources.memoryMiB,
    });

    // Infrastructure is usable; worker.js hand-off follows.
    await stampTaskRunMilestone({
      runId: taskRun.id,
      field: 'provisionReadyAt',
    }).catch((error) => {
      console.warn(
        `[spawnDaytonaWorker] Failed to stamp provisionReadyAt for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: taskRun.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'daytona',
        computeProviderId: machine.machineId,
        runId: taskRun.id,
        context: 'Daytona launch',
      });
    }

    console.log(
      `[spawnDaytonaWorker] Daytona instance created for task run #${taskRun.id} in ${Date.now() - createMachineStart}ms ${JSON.stringify(
        { machineId: machine.machineId, launchMode: launchOptions.launchMode },
      )}`,
    );

    await recordMutation({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Calling runCommand to launch detached worker ${workerCommand} for Daytona instance ${machine.machineId}.`,
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
      env: buildDaytonaWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + daytonaTimeoutMs,
        deploymentSlug,
        environmentId,
        snapshotName: daytonaSnapshotName,
        extraEnv: {
          SANDBOX_TIMEOUT_MS: String(daytonaTimeoutMs),
        },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });

    if (result.exitCode !== null && result.exitCode !== 0) {
      throw buildDetachedWorkerExitError(workerCommand, result);
    }

    await recordMutation({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `runCommand launched detached worker ${workerCommand} for Daytona instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
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
    await recordMutation({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'failed',
      instanceId: machine.machineId,
      message: `runCommand failed while launching detached worker for Daytona instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        ...(error instanceof DetachedWorkerLaunchError ? error.details : {}),
        error: error instanceof Error ? error.message : String(error),
      }),
    });

    await cleanupDaytonaInstance({
      computeClient,
      instanceId: machine.machineId,
      phase: 'spawn_worker',
      error,
      logPrefix: 'spawnDaytonaWorker',
      onMutation: recordMutation,
      ...mutationContext,
    });
    throw error;
  }
}
