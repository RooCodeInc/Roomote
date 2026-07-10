import {
  TaskPayloadKind,
  NonRetryableSpawnError,
  getPrimaryPortFromConfig,
} from '@roomote/types';
import {
  type Run,
  createComputeProviderMutationEventRecorder,
  db,
  taskRuns,
  eq,
} from '@roomote/db/server';
import { stampCloudJobMilestone } from '@roomote/sdk/server';
import {
  buildComputeProviderMutationDetails,
  buildE2bWorkerEnv,
  cleanupE2bInstance,
  createComputeProviderClient,
  createE2bMachine,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';

import { primeEnvironmentOidcForMachine } from '../sandbox-oidc';
import {
  getNamedPortsForCloudJob,
  shouldEnableAuthBypassForCloudJob,
  updateCloudJobMachine,
} from '../utils';

const E2B_LAUNCH_OUTPUT_TEXT_LIMIT = 500;

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

  return trimmed.length > E2B_LAUNCH_OUTPUT_TEXT_LIMIT
    ? `${trimmed.slice(0, E2B_LAUNCH_OUTPUT_TEXT_LIMIT)}...`
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

function getWorkerLaunchCommand(cloudJob: Run): 'snapshot' | 'resume' | 'run' {
  return cloudJob.payloadKind === TaskPayloadKind.SnapshotEnvironment
    ? 'snapshot'
    : cloudJob.payloadKind === TaskPayloadKind.SnapshotResume
      ? 'resume'
      : 'run';
}

function getWorkerLaunchArgs(cloudJob: Run, machineId: string): string[] {
  const command = getWorkerLaunchCommand(cloudJob);

  return cloudJob.payloadKind === TaskPayloadKind.SnapshotEnvironment
    ? [
        'snapshot',
        '--cloud-job-id',
        cloudJob.id.toString(),
        '--environment-id',
        cloudJob.payload.environmentId ?? '',
        '--sandbox-id',
        machineId,
      ]
    : [command, cloudJob.id.toString()];
}

export async function spawnE2bWorker(
  cloudJob: Run,
  authToken: string,
  config: {
    e2bApiKey: string;
    e2bDomain?: string;
    e2bTemplateId: string;
    e2bTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    e2bTags?: Record<string, string>;
  },
): Promise<{
  machineId: string;
  sandboxCmdId?: string;
}> {
  const {
    e2bApiKey,
    e2bDomain,
    e2bTemplateId,
    e2bTimeoutMs,
    localTarballPath,
    deploymentSlug,
    e2bTags,
  } = config;

  const environmentId = cloudJob.payload.environmentId;

  const { namedPorts, environmentSnapshotId, environmentConfig } =
    await getNamedPortsForCloudJob(cloudJob);

  const shouldEnableAuthBypass = shouldEnableAuthBypassForCloudJob({
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

  if (cloudJob.payloadKind === TaskPayloadKind.SnapshotResume) {
    const snapshotId = cloudJob.sourceSnapshotId;

    if (!snapshotId) {
      throw new NonRetryableSpawnError(
        `SnapshotResume job #${cloudJob.id} missing sourceSnapshotId`,
      );
    }

    launchOptions = {
      launchMode: 'task_snapshot',
      sourceSnapshotId: snapshotId,
    };
  } else if (cloudJob.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
    // Environment snapshot refreshes must rebuild from the configured base
    // template instead of inheriting the previous environment snapshot.
    launchOptions = { launchMode: 'fresh' };
  } else {
    // For all other job types, any
    // available snapshot—whether persisted on the job or resolved from the
    // environment—is treated as a cached base image. The latest shipped
    // worker/runtime is reinstalled on top before work begins.
    const snapshotId =
      cloudJob.sourceSnapshotId ?? environmentSnapshotId ?? undefined;

    launchOptions = snapshotId
      ? { launchMode: 'environment_snapshot', sourceSnapshotId: snapshotId }
      : { launchMode: 'fresh' };
  }

  if (
    cloudJob.payloadKind === TaskPayloadKind.SnapshotEnvironment &&
    !cloudJob.payload.environmentId
  ) {
    throw new Error(
      `SnapshotEnvironment job #${cloudJob.id} missing environmentId in payload`,
    );
  }

  console.log(
    `[spawnE2bWorker] Creating E2B instance for job #${cloudJob.id}... ${JSON.stringify(
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
      runId: cloudJob.id,
      taskId: cloudJob.taskId,
    },
    { logPrefix: 'spawnE2bWorker', logger: console },
  );

  const computeClient = createComputeProviderClient({
    provider: 'e2b',
    config: {
      apiKey: e2bApiKey,
      templateId: e2bTemplateId,
      ...(e2bDomain ? { domain: e2bDomain } : {}),
      timeoutMs: e2bTimeoutMs,
    },
  });

  // Stamp provisionStartedAt + launchMode before the E2B API call. Only-if-
  // null semantics preserve the earliest provision timestamp.
  await stampCloudJobMilestone({
    cloudJobId: cloudJob.id,
    field: 'provisionStartedAt',
    launchMode: launchOptions.launchMode,
  }).catch((error) => {
    console.warn(
      `[spawnE2bWorker] Failed to stamp provisionStartedAt for job #${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const machine = await createE2bMachine({
    e2bApiKey,
    e2bDomain,
    e2bTemplateId,
    namedPorts,
    tags: e2bTags,
    timeoutMs: e2bTimeoutMs,
    localTarballPath,
    createInstanceTimeoutMs: 180_000,
    bootstrapTimeoutMs: 120_000,
    computeClient,
    onMutation: recordMutation,
    ...launchOptions,
  });

  const command = getWorkerLaunchCommand(cloudJob);
  const args = getWorkerLaunchArgs(cloudJob, machine.machineId);

  try {
    await updateCloudJobMachine({
      cloudJob,
      vendor: 'e2b',
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
    });

    // Infrastructure is usable; worker.js hand-off follows.
    await stampCloudJobMilestone({
      cloudJobId: cloudJob.id,
      field: 'provisionReadyAt',
    }).catch((error) => {
      console.warn(
        `[spawnE2bWorker] Failed to stamp provisionReadyAt for job #${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: cloudJob.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'e2b',
        computeProviderId: machine.machineId,
        cloudJobId: cloudJob.id,
        context: 'Fresh E2B launch',
      });
    }

    console.log(
      `[spawnE2bWorker] E2B instance created for job #${cloudJob.id} in ${Date.now() - createMachineStart}ms ${JSON.stringify(
        { machineId: machine.machineId },
      )}`,
    );

    await recordMutation({
      provider: 'e2b',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Calling runCommand to launch detached worker ${command} for E2B instance ${machine.machineId}.`,
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
      env: buildE2bWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + e2bTimeoutMs,
        deploymentSlug,
        environmentId,
        templateId: e2bTemplateId,
        extraEnv: {
          SANDBOX_TIMEOUT_MS: String(e2bTimeoutMs),
        },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });

    if (result.exitCode !== null && result.exitCode !== 0) {
      throw buildDetachedWorkerExitError(command, result);
    }

    await recordMutation({
      provider: 'e2b',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `runCommand launched detached worker ${command} for E2B instance ${machine.machineId}.`,
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
        .where(eq(taskRuns.id, cloudJob.id));
    }

    return {
      machineId: machine.machineId,
      ...(result.commandId ? { sandboxCmdId: result.commandId } : {}),
    };
  } catch (error) {
    await recordMutation({
      provider: 'e2b',
      operation: 'run_command',
      eventType: 'failed',
      instanceId: machine.machineId,
      message: `runCommand failed while launching detached worker for E2B instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        ...(error instanceof DetachedWorkerLaunchError ? error.details : {}),
        error: error instanceof Error ? error.message : String(error),
      }),
    });

    await cleanupE2bInstance({
      computeClient,
      instanceId: machine.machineId,
      phase: 'spawn_worker',
      error,
      logPrefix: 'spawnE2bWorker',
      onMutation: recordMutation,
      ...mutationContext,
    });
    throw error;
  }
}
