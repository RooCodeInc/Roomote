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
  RoomoteBrokerClient,
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
  DetachedWorkerLaunchError,
  buildDetachedWorkerExitError,
} from './detached-worker-launch';
import { resolveTaskSandboxMemoryMiB } from './task-sandbox-resources';
import {
  COMPUTE_BOOTSTRAP_TIMEOUT_MS,
  COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
} from './timeouts';

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

export async function spawnModalWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    /**
     * Vendor persisted on the task run. `roomote` reuses this Modal
     * spawn path with deployment-managed credentials. Defaults to `modal`.
     */
    vendor?: 'modal' | 'roomote';
    /**
     * Engine backing a `roomote` spawn. With `broker`, modalTokenId /
     * modalTokenSecret carry the tenant id + derived broker credential and
     * all Modal operations go through the compute broker at `brokerUrl`;
     * no Modal workspace credentials exist in this deployment.
     */
    backend?: 'modal' | 'broker';
    brokerUrl?: string;
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
    /** Memory allocation for VM sandboxes that run nested Docker workloads. */
    modalVmMemoryMiB: number;
    modalTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    modalTags?: Record<string, string>;
    /**
     * Classifies a post-launch exit so the provider can clean up before an
     * optional fresh launch is scheduled.
     */
    onWorkerExit?: (event: {
      exitCode: number;
    }) => Promise<'ignore' | 'restart' | 'failed'>;
    onWorkerRestart?: () => void;
  },
): Promise<{
  machineId: string;
  sandboxCmdId?: string;
}> {
  const {
    vendor = 'modal',
    backend = 'modal',
    brokerUrl,
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
    modalVmMemoryMiB,
    modalTimeoutMs,
    localTarballPath,
    deploymentSlug,
    modalTags,
    onWorkerExit,
    onWorkerRestart,
  } = config;
  const parsedModalRegions = parseModalRegions(modalRegions);
  const environmentId = taskRun.payload.environmentId;

  const { namedPorts, environmentSnapshotId, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);

  const sandboxResources = await resolveTaskSandboxMemoryMiB(
    taskRun,
    environmentConfig,
  );
  const useVmRuntime = sandboxResources.needsNestedDocker;

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
    configuredCpuCores: 2,
    configuredMemoryMiB: useVmRuntime
      ? modalVmMemoryMiB
      : sandboxResources.memoryMiB,
  });
  const modalConfig = {
    vendor,
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

  const computeClient =
    backend === 'broker'
      ? new RoomoteBrokerClient({
          brokerUrl: brokerUrl ?? '',
          tenantId: modalTokenId,
          brokerKey: modalTokenSecret,
          baseImageRef: modalBaseImageRef,
          ...(parsedModalRegions ? { regions: parsedModalRegions } : {}),
          ...(useVmRuntime ? { vmRuntime: true } : {}),
          ...(configuredResources.configuredCpuCores !== null
            ? { cpu: configuredResources.configuredCpuCores }
            : {}),
          ...(configuredResources.configuredMemoryMiB !== null
            ? { memoryMiB: configuredResources.configuredMemoryMiB }
            : {}),
          timeoutMs: modalTimeoutMs,
        })
      : createComputeProviderClient({
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
    createInstanceTimeoutMs: COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
    bootstrapTimeoutMs: COMPUTE_BOOTSTRAP_TIMEOUT_MS,
    computeClient,
    onMutation: recordMutation,
    ...launchOptions,
  });

  const command = getWorkerLaunchCommand(taskRun);
  const args = getWorkerLaunchArgs(taskRun, machine.machineId);

  let immediateExitDisposition: 'restart' | 'failed' | undefined;

  try {
    await updateTaskRunMachine({
      taskRun,
      vendor,
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
        // The persisted vendor, not the literal 'modal': OIDC priming builds
        // its compute client from this provider, and a roomote launch must
        // resolve ROOMOTE_CLOUD_* credentials rather than MODAL_TOKEN_*.
        computeProvider: vendor,
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
      provider: vendor,
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
      ...(onWorkerExit
        ? {
            onExit: async ({ exitCode }: { exitCode: number }) => {
              const disposition = await onWorkerExit({ exitCode });

              if (disposition === 'ignore') {
                return;
              }

              try {
                await cleanupModalInstance({
                  computeClient,
                  instanceId: machine.machineId,
                  phase: 'worker_bootstrap_exit',
                  error: new Error(
                    `Detached worker exited before task run #${taskRun.id} started (exit code ${exitCode})`,
                  ),
                  logPrefix: 'spawnModalWorker',
                  onMutation: recordMutation,
                  ...mutationContext,
                });
              } finally {
                // The restart decision is already durable. Do not strand it if
                // provider cleanup fails; the new worker can still be launched
                // and the orphaned sandbox remains covered by orphan recovery.
                if (disposition === 'restart') {
                  onWorkerRestart?.();
                }
              }
            },
          }
        : {}),
    });

    // A detached worker must remain alive long enough to claim the run. Route
    // grace-period exits through the same classifier as later exits so the
    // first bootstrap failure gets its one durable replacement.
    if (result.exitCode !== null) {
      const exitError = buildDetachedWorkerExitError(command, result);

      if (onWorkerExit) {
        const disposition = await onWorkerExit({ exitCode: result.exitCode });

        if (disposition !== 'ignore') {
          immediateExitDisposition = disposition;
          throw exitError;
        }

        // The worker claimed the run before exiting, so its normal lifecycle
        // owns terminal state and sandbox cleanup from this point onward.
      } else {
        throw exitError;
      }
    }

    await recordMutation({
      provider: vendor,
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
        commandOutputLookupSupported:
          computeClient.capabilities.supportsCommandOutputLookup,
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
      provider: vendor,
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

    if (immediateExitDisposition) {
      try {
        await cleanupModalInstance({
          computeClient,
          instanceId: machine.machineId,
          phase: 'spawn_worker',
          error,
          logPrefix: 'spawnModalWorker',
          onMutation: recordMutation,
          ...mutationContext,
        });
      } catch (cleanupError) {
        console.error(
          `[spawnModalWorker] Cleanup failed after classified bootstrap exit for task run #${taskRun.id}`,
          cleanupError,
        );
      } finally {
        if (immediateExitDisposition === 'restart') {
          onWorkerRestart?.();
        }
      }

      // The controller already committed either Pending for a retry or Failed
      // for the exhausted retry budget. Avoid terminally failing it again in
      // BaseController.handleSpawnTaskRunError.
      return { machineId: machine.machineId };
    }

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
