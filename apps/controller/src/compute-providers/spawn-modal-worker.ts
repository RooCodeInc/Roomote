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
  sql,
} from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';
import {
  type ComputeProviderClient,
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
import { resolveTaskSandboxMemoryMiB } from './task-sandbox-resources';
import {
  COMPUTE_BOOTSTRAP_TIMEOUT_MS,
  COMPUTE_CREATE_INSTANCE_TIMEOUT_MS,
} from './timeouts';

const MODAL_LAUNCH_OUTPUT_TEXT_LIMIT = 500;
const LAUNCH_DIAGNOSTIC_PROBE_TIMEOUT_MS = 15_000;
const ROOMOTE_COMPUTE_LOG_LIMIT = 256 * 1024;
const ROOMOTE_COMPUTE_LOG_FLUSH_INTERVAL_MS = 500;
const ROOMOTE_COMPUTE_LOG_FLUSH_SIZE = 16 * 1024;

function createRoomoteComputeLogRecorder(runId: number) {
  let writes = Promise.resolve();
  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }

    if (!buffer) return writes;

    const entries = buffer;
    buffer = '';
    writes = writes
      .then(async () => {
        await db
          .update(taskRuns)
          .set({
            log: sql<string>`right(coalesce(${taskRuns.log}, '') || ${entries}, ${ROOMOTE_COMPUTE_LOG_LIMIT})`,
          })
          .where(eq(taskRuns.id, runId));
      })
      .catch((error: unknown) => {
        console.warn(
          `[spawnModalWorker] Failed to retain compute output for task run #${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return writes;
  };

  const append = (
    stream: 'command' | 'stdout' | 'stderr',
    data: string,
    timestamp = new Date(),
  ): Promise<void> => {
    const prefix = `[${timestamp.toISOString()}] [${stream}] `;
    const sanitized = data.replaceAll('\0', '');
    const suffix = sanitized.endsWith('\n') ? '' : '\n';
    const available = ROOMOTE_COMPUTE_LOG_LIMIT - prefix.length - suffix.length;
    const retained =
      sanitized.length > available ? sanitized.slice(-available) : sanitized;
    buffer += `${prefix}${retained}${suffix}`;

    if (
      stream === 'command' ||
      buffer.length >= ROOMOTE_COMPUTE_LOG_FLUSH_SIZE
    ) {
      return flush();
    }

    flushTimer ??= setTimeout(
      () => void flush(),
      ROOMOTE_COMPUTE_LOG_FLUSH_INTERVAL_MS,
    );
    flushTimer.unref?.();
    return writes;
  };

  return { append, flush };
}

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

/**
 * Everything captured about a dead launch — stderr, stdout, and any probe
 * output — as a single string, or undefined when nothing was captured. This
 * is what makes the failure actionable, so it travels both in the thrown
 * error and through onWorkerExit into the bootstrap-failure run error.
 */
function buildLaunchOutputSummary(
  result: { stdout?: string; stderr?: string },
  probeDiagnostics?: string,
): string | undefined {
  const stdout = truncateLaunchOutput(result.stdout);
  const stderr = truncateLaunchOutput(result.stderr);
  const parts = [
    ...(stderr ? [`stderr: ${stderr}`] : []),
    ...(stdout ? [`stdout: ${stdout}`] : []),
    ...(probeDiagnostics ? [probeDiagnostics] : []),
  ];

  return parts.length > 0 ? parts.join('; ') : undefined;
}

function buildDetachedWorkerExitError(
  command: string,
  result: {
    exitCode: number | null;
    commandId?: string;
    stdout?: string;
    stderr?: string;
  },
  probeDiagnostics?: string,
): DetachedWorkerLaunchError {
  const stdout = truncateLaunchOutput(result.stdout);
  const stderr = truncateLaunchOutput(result.stderr);
  const summary = buildLaunchOutputSummary(result, probeDiagnostics);
  const message = `Detached "worker ${command}" exited immediately with code ${result.exitCode}${
    summary ? `; ${summary}` : ''
  }`;

  return new DetachedWorkerLaunchError(message, {
    commandId: result.commandId ?? null,
    exitCode: result.exitCode,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(probeDiagnostics ? { launchDiagnostics: probeDiagnostics } : {}),
  });
}

/**
 * Modal regularly loses the output of a detached process that dies within the
 * launch grace window, leaving "exited immediately with code N" with no
 * stderr to act on. A non-detached `worker --version` in the same sandbox
 * reproduces any crash that happens before the CLI dispatches a command
 * (module-level env validation, a broken bundle, a missing runtime
 * dependency) and its output streams back reliably. The probe parses no
 * command, so it cannot claim the task run or mutate anything.
 */
async function captureWorkerLaunchDiagnostics(
  computeClient: ComputeProviderClient,
  instanceId: string,
): Promise<string> {
  try {
    const probe = await computeClient.runCommand({
      instanceId,
      cmd: 'worker',
      args: ['--version'],
      signal: AbortSignal.timeout(LAUNCH_DIAGNOSTIC_PROBE_TIMEOUT_MS),
    });
    const probeStderr = truncateLaunchOutput(probe.stderr);
    const probeStdout = truncateLaunchOutput(probe.stdout);

    return [
      `probe "worker --version" exited with code ${probe.exitCode}`,
      ...(probeStderr ? [`probe stderr: ${probeStderr}`] : []),
      ...(probeStdout ? [`probe stdout: ${probeStdout}`] : []),
    ].join('; ');
  } catch (error) {
    return `probe "worker --version" failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
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
     * optional fresh launch is scheduled. Grace-period exits pass everything
     * captured about the dead launch (stderr/stdout/probe output) as
     * `launchDiagnostics` so the bootstrap-failure finalization can persist
     * it on the run instead of a bare exit code.
     */
    onWorkerExit?: (event: {
      exitCode: number;
      launchDiagnostics?: string;
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
  const computeLog =
    vendor === 'roomote'
      ? createRoomoteComputeLogRecorder(taskRun.id)
      : undefined;

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

  await computeLog?.append('command', 'sandbox provisioning started');
  let machine: Awaited<ReturnType<typeof createModalMachine>>;
  try {
    machine = await createModalMachine({
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
  } catch (error) {
    await computeLog?.append(
      'command',
      `sandbox provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }

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
    await computeLog?.append(
      'command',
      `worker ${args.join(' ')} started on ${machine.machineId}`,
    );

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
      ...(computeLog
        ? {
            onOutput: (event: {
              stream: 'stdout' | 'stderr';
              data: string;
            }) => {
              void computeLog.append(event.stream, event.data);
            },
          }
        : {}),
      ...(onWorkerExit || computeLog
        ? {
            onExit: async ({ exitCode }: { exitCode: number }) => {
              await computeLog?.append(
                'command',
                `worker exited with code ${exitCode}`,
              );

              if (!onWorkerExit) {
                return;
              }

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
    await computeLog?.flush();

    // A detached worker must remain alive long enough to claim the run. Route
    // grace-period exits through the same classifier as later exits so the
    // first bootstrap failure gets its one durable replacement.
    if (result.exitCode !== null) {
      await computeLog?.append(
        'command',
        `worker exited with code ${result.exitCode}`,
      );
      // Without any captured output the exit is undiagnosable from logs, so
      // probe the still-alive sandbox before classification/cleanup.
      const probeDiagnostics =
        truncateLaunchOutput(result.stdout) ||
        truncateLaunchOutput(result.stderr)
          ? undefined
          : await captureWorkerLaunchDiagnostics(
              computeClient,
              machine.machineId,
            );
      const launchDiagnostics = buildLaunchOutputSummary(
        result,
        probeDiagnostics,
      );
      const exitError = buildDetachedWorkerExitError(
        command,
        result,
        probeDiagnostics,
      );

      if (onWorkerExit) {
        // The classifier finalizes the run itself on the 'failed' disposition
        // (this spawn then returns without rethrowing), so the diagnostics
        // must travel with the exit event to reach the run's error.
        const disposition = await onWorkerExit({
          exitCode: result.exitCode,
          ...(launchDiagnostics ? { launchDiagnostics } : {}),
        });

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
    await computeLog?.append(
      'command',
      result.commandId
        ? `worker is running as command ${result.commandId}`
        : 'worker is running',
    );

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
    await computeLog?.append(
      'command',
      `worker launch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
