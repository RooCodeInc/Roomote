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
  buildAzureWorkerEnv,
  cleanupAzureInstance,
  createComputeProviderClient,
  createAzureMachine,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
  parseAzureSizePreset,
  AZURE_SIZE_PRESETS,
  type ComputeProviderClient,
} from '@roomote/compute-providers';

import { primeEnvironmentOidcForMachine } from '../sandbox-oidc';
import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';
import {
  DetachedWorkerLaunchError,
  buildDetachedWorkerExitError,
} from './detached-worker-launch';
import { resolveTaskSandboxMemoryMiB } from './task-sandbox-resources';
import {
  COMPUTE_BOOTSTRAP_TIMEOUT_MS,
  COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
} from './timeouts';

async function resolveAzureResumeLaunchOptions(
  snapshotId: string,
  computeClient: Pick<ComputeProviderClient, 'getInstanceStatus'>,
): Promise<
  | { launchMode: 'task_standby'; resumeHandle: string }
  | { launchMode: 'task_snapshot'; sourceSnapshotId: string }
> {
  try {
    const status = await computeClient.getInstanceStatus({
      instanceId: snapshotId,
    });
    if (status.status === 'stopped' || status.status === 'running') {
      return { launchMode: 'task_standby', resumeHandle: snapshotId };
    }
  } catch {
    // Not a live sandbox — treat as a genuine snapshot id.
  }

  return { launchMode: 'task_snapshot', sourceSnapshotId: snapshotId };
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

export async function spawnAzureWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    azureSubscriptionId: string;
    azureResourceGroup: string;
    azureSandboxGroup: string;
    azureRegion: string;
    azureDiskImage: string;
    azureClientId?: string;
    azureTenantId?: string;
    azureClientSecret?: string;
    /** ACA size tier (S/M/L/XL...); sets the default sandbox size. */
    azureSize?: string;
    azureTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    azureTags?: Record<string, string>;
  },
): Promise<{
  machineId: string;
  sandboxCmdId?: string;
}> {
  const {
    azureSubscriptionId,
    azureResourceGroup,
    azureSandboxGroup,
    azureRegion,
    azureDiskImage,
    azureClientId,
    azureTenantId,
    azureClientSecret,
    azureSize,
    azureTimeoutMs,
    localTarballPath,
    deploymentSlug,
    azureTags,
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

  // Service principal auth only kicks in with the full triple; a lone
  // AZURE_CLIENT_ID means user-assigned managed identity.
  const azureServicePrincipal =
    azureTenantId && azureClientId && azureClientSecret
      ? {
          tenantId: azureTenantId,
          clientId: azureClientId,
          clientSecret: azureClientSecret,
        }
      : undefined;

  // Size handling: the operator's AZURE_SANDBOX_SIZE picks the default
  // tier (cpu/memory/disk). The task-side memory constant is only a
  // platform default — not a user preference — so the provider size wins.
  // Nested-Docker tasks bypass the preset entirely: their 8 GiB memory is
  // hard, and a small preset's 20 GiB disk would otherwise cap image builds.
  const azureSizePreset = parseAzureSizePreset(azureSize);
  const effectiveSizePreset = sandboxResources.needsNestedDocker
    ? undefined
    : azureSizePreset;
  const memoryMiB =
    sandboxResources.needsNestedDocker || !effectiveSizePreset
      ? sandboxResources.memoryMiB
      : undefined;
  // Record the size the provider will actually provision (preset when the
  // override is omitted), not the task-side platform default.
  const effectiveMemoryMiB =
    memoryMiB ??
    (effectiveSizePreset
      ? AZURE_SIZE_PRESETS[effectiveSizePreset].memoryMiB
      : sandboxResources.memoryMiB);

  const computeClient = createComputeProviderClient({
    provider: 'azure',
    config: {
      subscriptionId: azureSubscriptionId,
      resourceGroup: azureResourceGroup,
      sandboxGroup: azureSandboxGroup,
      region: azureRegion,
      diskImage: azureDiskImage,
      ...(azureServicePrincipal
        ? { servicePrincipal: azureServicePrincipal }
        : azureClientId
          ? { managedIdentityClientId: azureClientId }
          : {}),
      ...(effectiveSizePreset ? { size: effectiveSizePreset } : {}),
      ...(memoryMiB !== undefined ? { memoryMiB } : {}),
      // Nested-Docker workloads get at least the L-tier disk for image
      // builds; preset disks apply otherwise.
      ...(sandboxResources.needsNestedDocker ? { diskSize: '40Gi' } : {}),
      timeoutMs: azureTimeoutMs,
    },
  });

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

    // Azure is dual-capable: task sleeps always use standby (the sleep-check
    // pipeline prefers standby for standby-capable vendors), so a
    // SnapshotResume's id is usually a suspended-sandbox handle, not a
    // snapshot. Discriminate by probing whether the id is a live sandbox;
    // manual task snapshots land in the snapshot branch instead.
    launchOptions = await resolveAzureResumeLaunchOptions(
      snapshotId,
      computeClient,
    );
  } else if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
    // Environment snapshot refreshes must rebuild from the configured base
    // worker disk image instead of inheriting the previous environment snapshot.
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
    `[spawnAzureWorker] Creating Azure instance for task run #${taskRun.id}... ${JSON.stringify(
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
      'resumeHandle' in launchOptions
        ? launchOptions.resumeHandle
        : 'sourceSnapshotId' in launchOptions
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
    { logPrefix: 'spawnAzureWorker', logger: console },
  );

  // Stamp provisionStartedAt + launchMode before the Azure API call. Only-if-
  // null semantics preserve the earliest provision timestamp.
  await stampTaskRunMilestone({
    runId: taskRun.id,
    field: 'provisionStartedAt',
    launchMode: launchOptions.launchMode,
  }).catch((error) => {
    console.warn(
      `[spawnAzureWorker] Failed to stamp provisionStartedAt for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const machine = await createAzureMachine({
    azureSubscriptionId,
    azureResourceGroup,
    azureSandboxGroup,
    azureRegion,
    azureDiskImage,
    azureClientId,
    azureTenantId,
    azureClientSecret,
    namedPorts,
    tags: azureTags,
    timeoutMs: azureTimeoutMs,
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
      vendor: 'azure',
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
      configuredMemoryMiB: effectiveMemoryMiB,
    });

    // Infrastructure is usable; worker.js hand-off follows.
    await stampTaskRunMilestone({
      runId: taskRun.id,
      field: 'provisionReadyAt',
    }).catch((error) => {
      console.warn(
        `[spawnAzureWorker] Failed to stamp provisionReadyAt for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: taskRun.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'azure',
        computeProviderId: machine.machineId,
        runId: taskRun.id,
        context: 'Azure launch',
      });
    }

    console.log(
      `[spawnAzureWorker] Azure instance created for task run #${taskRun.id} in ${Date.now() - createMachineStart}ms ${JSON.stringify(
        { machineId: machine.machineId, launchMode: launchOptions.launchMode },
      )}`,
    );

    if (
      launchOptions.launchMode === 'task_standby' ||
      launchOptions.launchMode === 'task_snapshot'
    ) {
      // Suspend/resume and snapshot/restore revive previously frozen worker
      // processes whose runs were finalized while they were away — dead
      // tokens, and they hold the sandbox-server port, which kills the
      // incoming worker's boot. Reap them before launch. pkill exits 1 when
      // nothing matches; that is the common case and not an error.
      await computeClient
        .runCommand({
          instanceId: machine.machineId,
          cmd: 'pkill',
          args: ['-f', '/sandbox/worker/dist/worker.js'],
          signal: AbortSignal.timeout(15_000),
        })
        .catch((error) => {
          console.warn(
            `[spawnAzureWorker] Pre-launch worker reaper failed for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    await recordMutation({
      provider: 'azure',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Calling runCommand to launch detached worker ${workerCommand} for Azure instance ${machine.machineId}.`,
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
      env: buildAzureWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + azureTimeoutMs,
        deploymentSlug,
        environmentId,
        diskImage: azureDiskImage,
        extraEnv: {
          SANDBOX_TIMEOUT_MS: String(azureTimeoutMs),
        },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });

    if (result.exitCode !== null && result.exitCode !== 0) {
      throw buildDetachedWorkerExitError(workerCommand, result);
    }

    await recordMutation({
      provider: 'azure',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `runCommand launched detached worker ${workerCommand} for Azure instance ${machine.machineId}.`,
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
      provider: 'azure',
      operation: 'run_command',
      eventType: 'failed',
      instanceId: machine.machineId,
      message: `runCommand failed while launching detached worker for Azure instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        ...(error instanceof DetachedWorkerLaunchError ? error.details : {}),
        error: error instanceof Error ? error.message : String(error),
      }),
    });

    await cleanupAzureInstance({
      computeClient,
      instanceId: machine.machineId,
      phase: 'spawn_worker',
      error,
      logPrefix: 'spawnAzureWorker',
      onMutation: recordMutation,
      ...mutationContext,
    });
    throw error;
  }
}
