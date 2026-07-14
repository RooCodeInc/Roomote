import {
  TaskPayloadKind,
  NonRetryableSpawnError,
  resolveConfiguredComputeProviderResources,
  getPrimaryPortFromConfig,
} from '@roomote/types';
import {
  type TaskRun,
  createComputeProviderMutationEventRecorder,
  db,
  tasks,
  taskRuns,
  eq,
} from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';
import {
  buildComputeProviderMutationDetails,
  buildModalWorkerEnv,
  cleanupModalInstance,
  createComputeProviderClient,
  createModalMachine,
  parseModalRegions,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';

import { primeEnvironmentOidcForMachine } from '../sandbox-oidc';
import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';

const MODAL_LAUNCH_OUTPUT_TEXT_LIMIT = 500;

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

  return trimmed.length > MODAL_LAUNCH_OUTPUT_TEXT_LIMIT
    ? `${trimmed.slice(0, MODAL_LAUNCH_OUTPUT_TEXT_LIMIT)}...`
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
  const parts = [message];

  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }

  if (stdout) {
    parts.push(`stdout: ${stdout}`);
  }

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

async function needsModalVmRuntime(
  taskRun: TaskRun,
  environmentConfig: Awaited<
    ReturnType<typeof getNamedPortsForTaskRun>
  >['environmentConfig'],
): Promise<boolean> {
  if (environmentConfig?.docker_projects?.length) {
    return true;
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskRun.taskId),
    columns: { workflow: true },
  });

  // Environment setup must be able to discover and validate Docker projects
  // before an environment config exists to advertise that requirement.
  return task?.workflow === 'setup_onboarding';
}

export async function spawnModalWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    modalTokenId: string;
    modalTokenSecret: string;
    modalEndpoint?: string;
    modalEnvironment?: string;
    modalAppName?: string;
    modalBaseImageRef: string;
    modalRegistryUsername?: string;
    modalRegistryPassword?: string;
    modalEcrOidcRoleArn?: string;
    modalEcrRegion?: string;
    /** Comma-separated Modal placement region tokens (`MODAL_REGIONS`). */
    modalRegions?: string;
    modalTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    modalTags?: Record<string, string>;
  },
): Promise<{
  machineId: string;
  sandboxCmdId?: string;
}> {
  const {
    modalTokenId,
    modalTokenSecret,
    modalEndpoint,
    modalEnvironment,
    modalAppName,
    modalBaseImageRef,
    modalRegistryUsername,
    modalRegistryPassword,
    modalEcrOidcRoleArn,
    modalEcrRegion,
    modalRegions,
    modalTimeoutMs,
    localTarballPath,
    deploymentSlug,
    modalTags,
  } = config;
  const parsedModalRegions = parseModalRegions(modalRegions);
  const environmentId = taskRun.payload.environmentId;

  const { namedPorts, environmentSnapshotId, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);

  const useVmRuntime = await needsModalVmRuntime(taskRun, environmentConfig);

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
    // image path instead of inheriting the previous environment snapshot.
    launchOptions = { launchMode: 'fresh' };
  } else {
    // For all other task run kinds, any
    // available snapshot—whether persisted on the task run or resolved from the
    // environment—is treated as a cached base image. The latest shipped
    // worker/runtime is reinstalled on top before work begins.
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
    `[spawnModalWorker] Creating modal instance for task run #${taskRun.id}... ${JSON.stringify(
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
    { logPrefix: 'spawnModalWorker', logger: console },
  );

  const configuredResources = resolveConfiguredComputeProviderResources({
    provider: 'modal',
    ...(useVmRuntime
      ? { configuredCpuCores: 2, configuredMemoryMiB: 4096 }
      : {}),
  });
  const modalConfig = {
    tokenId: modalTokenId,
    tokenSecret: modalTokenSecret,
    baseImageRef: modalBaseImageRef,
    ...(modalEndpoint ? { endpoint: modalEndpoint } : {}),
    ...(modalEnvironment ? { environment: modalEnvironment } : {}),
    ...(modalAppName ? { appName: modalAppName } : {}),
    ...(modalRegistryUsername
      ? { registryUsername: modalRegistryUsername }
      : {}),
    ...(modalRegistryPassword
      ? { registryPassword: modalRegistryPassword }
      : {}),
    ...(modalEcrOidcRoleArn ? { ecrOidcRoleArn: modalEcrOidcRoleArn } : {}),
    ...(modalEcrRegion ? { ecrRegion: modalEcrRegion } : {}),
    ...(parsedModalRegions ? { regions: parsedModalRegions } : {}),
    ...(useVmRuntime ? { vmRuntime: true } : {}),
    ...(configuredResources.configuredCpuCores !== null
      ? { cpu: configuredResources.configuredCpuCores }
      : {}),
    ...(configuredResources.configuredMemoryMiB !== null
      ? { memoryMiB: configuredResources.configuredMemoryMiB }
      : {}),
    timeoutMs: modalTimeoutMs,
  };

  const computeClient = createComputeProviderClient({
    provider: 'modal',
    config: modalConfig,
  });

  // Stamp provisionStartedAt + launchMode before the Modal API call. Only-if-
  // null semantics preserve the earliest provision timestamp.
  await stampTaskRunMilestone({
    runId: taskRun.id,
    field: 'provisionStartedAt',
    launchMode: launchOptions.launchMode,
  }).catch((error) => {
    console.warn(
      `[spawnModalWorker] Failed to stamp provisionStartedAt for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const machine = await createModalMachine({
    modalTokenId,
    modalTokenSecret,
    modalEndpoint,
    modalEnvironment,
    modalAppName,
    modalBaseImageRef,
    modalRegistryUsername,
    modalRegistryPassword,
    modalEcrOidcRoleArn,
    modalEcrRegion,
    namedPorts,
    tags: modalTags,
    timeoutMs: modalTimeoutMs,
    localTarballPath,
    createInstanceTimeoutMs: 180_000,
    bootstrapTimeoutMs: 120_000,
    computeClient,
    onMutation: recordMutation,
    ...launchOptions,
  });

  const command = getWorkerLaunchCommand(taskRun);
  const args = getWorkerLaunchArgs(taskRun, machine.machineId);

  try {
    await updateTaskRunMachine({
      taskRun,
      vendor: 'modal',
      machineId: machine.machineId,
      namedPorts,
      domainFn: (port) => machine.domain(port),
      proxyPorts: machine.proxyPorts ?? {},
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sourceSnapshotId:
        'sourceSnapshotId' in launchOptions
          ? launchOptions.sourceSnapshotId
          : null,
      authBypassValue,
      authBypassHeaderName,
      ...configuredResources,
    });

    // Infrastructure is usable; worker.js hand-off follows.
    await stampTaskRunMilestone({
      runId: taskRun.id,
      field: 'provisionReadyAt',
    }).catch((error) => {
      console.warn(
        `[spawnModalWorker] Failed to stamp provisionReadyAt for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: taskRun.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'modal',
        computeProviderId: machine.machineId,
        runId: taskRun.id,
        context: 'Fresh Modal launch',
      });
    }

    console.log(
      `[spawnModalWorker] Modal instance created for task run #${taskRun.id} in ${Date.now() - createMachineStart}ms ${JSON.stringify(
        { machineId: machine.machineId },
      )}`,
    );
    await recordMutation({
      provider: 'modal',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Calling runCommand to launch detached worker ${command} for Modal instance ${machine.machineId}.`,
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
      env: buildModalWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + modalTimeoutMs,
        deploymentSlug,
        environmentId,
        baseImageRef: modalBaseImageRef,
        extraEnv: {
          SANDBOX_TIMEOUT_MS: String(modalTimeoutMs),
        },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });

    if (result.exitCode !== null && result.exitCode !== 0) {
      throw buildDetachedWorkerExitError(command, result);
    }

    await recordMutation({
      provider: 'modal',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `runCommand launched detached worker ${command} for Modal instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        commandId: result.commandId ?? null,
        exitCode: result.exitCode,
      }),
    });

    if (!result.commandId) {
      console.warn(
        `[spawnModalWorker] Missing command ID for detached "worker ${command}" on task run #${taskRun.id}; startup log streaming is reduced for modal v1`,
      );
    }

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
      provider: 'modal',
      operation: 'run_command',
      eventType: 'failed',
      instanceId: machine.machineId,
      message: `runCommand failed while launching detached worker for Modal instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        ...(error instanceof DetachedWorkerLaunchError ? error.details : {}),
        error: error instanceof Error ? error.message : String(error),
      }),
    });

    await cleanupModalInstance({
      computeClient,
      instanceId: machine.machineId,
      phase: 'spawn_worker',
      error,
      logPrefix: 'spawnModalWorker',
      onMutation: recordMutation,
      ...mutationContext,
    });
    throw error;
  }
}
